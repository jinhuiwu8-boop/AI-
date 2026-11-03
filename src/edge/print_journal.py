"""Local durable print intent/result journal. Never executes a printer command."""
import json
import sqlite3
from datetime import datetime, timezone


class JournalError(ValueError):
    pass


class PrintJournal:
    def __init__(self, filename):
        self.db = sqlite3.connect(filename, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA busy_timeout=5000')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL,
          intent_at TEXT, result TEXT, result_id TEXT UNIQUE, acked INTEGER NOT NULL DEFAULT 0,
          delivery_attempts INTEGER NOT NULL DEFAULT 0, last_delivery_error TEXT);
        ''')

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _transaction(self, fn):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            value = fn()
            self.db.execute('COMMIT')
            return value
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def _row(self, attempt_id):
        row = self.db.execute('SELECT * FROM attempts WHERE id=?', (attempt_id,)).fetchone()
        if row is None:
            raise JournalError('ATTEMPT_NOT_FOUND')
        return row

    def get(self, attempt_id):
        row = self._row(attempt_id)
        return dict(json.loads(row['binding']), state=row['state'], intentAt=row['intent_at'],
                    result=json.loads(row['result']) if row['result'] else None,
                    resultId=row['result_id'], acked=bool(row['acked']),
                    deliveryAttempts=row['delivery_attempts'])

    def register(self, attempt_id, *, order_id, revision, document_sha256, copies=1):
        import re
        if not all(isinstance(v, str) and v.strip() and len(v) <= 200 for v in (attempt_id, order_id)):
            raise JournalError('INVALID_ID')
        if type(revision) is not int or revision < 1:
            raise JournalError('INVALID_REVISION')
        if type(copies) is not int or copies != 1:
            raise JournalError('COPIES_MUST_BE_ONE')
        if not isinstance(document_sha256, str) or not re.fullmatch('[a-fA-F0-9]{64}', document_sha256):
            raise JournalError('INVALID_DOCUMENT_SHA256')
        binding = json.dumps(dict(attemptId=attempt_id, orderId=order_id, revision=revision,
                                  documentSha256=document_sha256.lower(), copies=copies), sort_keys=True)

        def write():
            row = self.db.execute('SELECT binding FROM attempts WHERE id=?', (attempt_id,)).fetchone()
            if row and row['binding'] != binding:
                raise JournalError('ATTEMPT_BINDING_CONFLICT')
            self.db.execute("INSERT OR IGNORE INTO attempts(id,binding,state) VALUES(?,?,'PREPARED')", (attempt_id, binding))
            return self.get(attempt_id)
        return self._transaction(write)

    def begin_submission(self, attempt_id):
        """Commit intent before caller may invoke spooler. Repeated intent is rejected."""
        def write():
            row = self._row(attempt_id)
            if row['state'] != 'PREPARED':
                raise JournalError('RESUBMISSION_FORBIDDEN')
            self.db.execute("UPDATE attempts SET state='SUBMIT_INTENT',intent_at=? WHERE id=?",
                            (datetime.now(timezone.utc).isoformat(), attempt_id))
            return self.get(attempt_id)
        return self._transaction(write)

    def record_result(self, attempt_id, *, outcome, queue_id=None, error_code=None):
        if outcome not in ('ACCEPTED', 'UNCERTAIN', 'FAILED_BEFORE_SPOOL'):
            raise JournalError('INVALID_OUTCOME')
        if queue_id is not None and (not isinstance(queue_id, str) or not queue_id.strip() or len(queue_id) > 200):
            raise JournalError('INVALID_QUEUE_ID')
        if outcome == 'ACCEPTED' and not queue_id:
            raise JournalError('QUEUE_ID_REQUIRED')
        if error_code is not None and (not isinstance(error_code, str) or len(error_code) > 200):
            raise JournalError('INVALID_ERROR_CODE')
        result = json.dumps(dict(outcome=outcome, queueId=queue_id, errorCode=error_code), sort_keys=True)

        def write():
            row = self._row(attempt_id)
            if row['result'] is not None:
                if row['result'] != result:
                    raise JournalError('RESULT_CONFLICT')
                return self.get(attempt_id)
            if row['state'] != 'SUBMIT_INTENT' and not (row['state'] == 'PREPARED' and outcome == 'FAILED_BEFORE_SPOOL'):
                raise JournalError('RESULT_WITHOUT_INTENT')
            if outcome == 'FAILED_BEFORE_SPOOL' and queue_id:
                raise JournalError('FAILED_RESULT_HAS_QUEUE')
            # Result and pending outbox are one transaction, never two writes.
            self.db.execute('UPDATE attempts SET state=?,result=?,result_id=? WHERE id=?',
                            (outcome, result, f'print-result:{attempt_id}', attempt_id))
            return self.get(attempt_id)
        return self._transaction(write)

    def pending_results(self):
        return [self.get(row['id']) for row in self.db.execute('SELECT id FROM attempts WHERE result IS NOT NULL AND acked=0 ORDER BY id').fetchall()]

    def record_delivery_failure(self, result_id, error_code):
        if not isinstance(error_code, str) or len(error_code) > 200:
            raise JournalError('INVALID_ERROR_CODE')
        def write():
            row = self.db.execute('SELECT id,acked FROM attempts WHERE result_id=?', (result_id,)).fetchone()
            if row is None:
                raise JournalError('RESULT_NOT_FOUND')
            if not row['acked']:
                self.db.execute('UPDATE attempts SET delivery_attempts=delivery_attempts+1,last_delivery_error=? WHERE id=?', (error_code, row['id']))
            return self.get(row['id'])
        return self._transaction(write)

    def acknowledge(self, result_id):
        """Call only after transport has verified the cloud's matching durable ACK."""
        def write():
            row = self.db.execute('SELECT id FROM attempts WHERE result_id=?', (result_id,)).fetchone()
            if row is None:
                raise JournalError('RESULT_NOT_FOUND')
            self.db.execute('UPDATE attempts SET acked=1,last_delivery_error=NULL WHERE id=?', (row['id'],))
            return self.get(row['id'])
        return self._transaction(write)

    def recover(self):
        """Intent without result is potentially submitted; never expose as printable."""
        unresolved = [self.get(row['id']) for row in self.db.execute("SELECT id FROM attempts WHERE state='SUBMIT_INTENT' ORDER BY id").fetchall()]
        prepared = [self.get(row['id']) for row in self.db.execute("SELECT id FROM attempts WHERE state='PREPARED' ORDER BY id").fetchall()]
        return dict(potentiallySubmitted=unresolved, pendingResults=self.pending_results(),
                    prepared=prepared, autoReprint=[])
