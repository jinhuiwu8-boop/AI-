import importlib.util
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parents[2] / 'src' / 'edge' / 'print_journal.py'
spec = importlib.util.spec_from_file_location('print_journal', MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PrintJournal, JournalError = module.PrintJournal, module.JournalError


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='print-journal-test-')
        self.filename = str(Path(self.temp.name) / 'journal.sqlite')
        self.journal = PrintJournal(self.filename)

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def register(self, **changes):
        values = dict(order_id='synthetic-order', revision=1, document_sha256='a' * 64, copies=1)
        values.update(changes)
        return self.journal.register('attempt-1', **values)

    def restart(self):
        self.journal.close()
        self.journal = PrintJournal(self.filename)

    def test_intent_survives_restart_and_cannot_reprint(self):
        self.register()
        self.journal.begin_submission('attempt-1')
        self.restart()  # Simulates losing process after durable intent, before result.
        recovery = self.journal.recover()
        self.assertEqual(len(recovery['potentiallySubmitted']), 1)
        self.assertEqual(recovery['autoReprint'], [])
        self.assertEqual(recovery['prepared'], [])
        with self.assertRaisesRegex(JournalError, 'RESUBMISSION_FORBIDDEN'):
            self.journal.begin_submission('attempt-1')
        self.journal.record_result('attempt-1', outcome='UNCERTAIN', error_code='RESTART_NO_RECEIPT')
        self.assertEqual(self.journal.pending_results()[0]['result']['outcome'], 'UNCERTAIN')

    def test_outbox_failure_retry_ack_and_reopen(self):
        self.register()
        self.journal.begin_submission('attempt-1')
        row = self.journal.record_result('attempt-1', outcome='ACCEPTED', queue_id='synthetic-queue-1')
        result_id = row['resultId']
        self.journal.record_delivery_failure(result_id, 'NETWORK_UNAVAILABLE')
        self.restart()
        self.assertEqual(self.journal.pending_results()[0]['deliveryAttempts'], 1)
        self.assertEqual(self.journal.pending_results()[0]['result']['queueId'], 'synthetic-queue-1')
        self.assertEqual(self.journal.record_result('attempt-1', outcome='ACCEPTED', queue_id='synthetic-queue-1')['resultId'], result_id)
        self.journal.acknowledge(result_id)
        self.journal.acknowledge(result_id)
        self.restart()
        self.assertEqual(self.journal.pending_results(), [])
        self.assertTrue(self.journal.get('attempt-1')['acked'])

    def test_binding_immutable_and_copies_one(self):
        original = self.register()
        self.assertEqual(self.register(), original)
        for change in (dict(revision=2), dict(order_id='different'), dict(document_sha256='b' * 64)):
            with self.assertRaisesRegex(JournalError, 'ATTEMPT_BINDING_CONFLICT'):
                self.register(**change)
        for copies in (0, 2, -1, True, 1.0):
            with self.assertRaisesRegex(JournalError, 'COPIES_MUST_BE_ONE'):
                self.register(copies=copies)
        self.assertEqual(self.journal.get('attempt-1'), original)

    def test_invalid_result_does_not_partially_write(self):
        self.register()
        with self.assertRaisesRegex(JournalError, 'RESULT_WITHOUT_INTENT'):
            self.journal.record_result('attempt-1', outcome='ACCEPTED', queue_id='q')
        self.journal.begin_submission('attempt-1')
        with self.assertRaisesRegex(JournalError, 'QUEUE_ID_REQUIRED'):
            self.journal.record_result('attempt-1', outcome='ACCEPTED')
        self.assertEqual(self.journal.get('attempt-1')['state'], 'SUBMIT_INTENT')
        self.journal.record_result('attempt-1', outcome='UNCERTAIN')
        with self.assertRaisesRegex(JournalError, 'RESULT_CONFLICT'):
            self.journal.record_result('attempt-1', outcome='ACCEPTED', queue_id='q')
        with self.assertRaisesRegex(JournalError, 'RESULT_NOT_FOUND'):
            self.journal.acknowledge('unknown')

    def test_pre_spool_failure_is_durable_not_retryable_same_attempt(self):
        self.register()
        self.journal.record_result('attempt-1', outcome='FAILED_BEFORE_SPOOL', error_code='SYNTHETIC_PREFLIGHT')
        self.restart()
        self.assertEqual(len(self.journal.pending_results()), 1)
        self.assertEqual(self.journal.recover()['autoReprint'], [])
        with self.assertRaisesRegex(JournalError, 'RESUBMISSION_FORBIDDEN'):
            self.journal.begin_submission('attempt-1')

    def test_abrupt_process_exit_after_intent_is_conservative(self):
        script = '''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('journal', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
j = m.PrintJournal(sys.argv[2])
j.register('crash-attempt', order_id='synthetic', revision=2, document_sha256='c'*64)
j.begin_submission('crash-attempt')
os._exit(17)
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(MODULE), self.filename], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 17, result.stderr.decode())
        self.restart()
        self.assertEqual(self.journal.recover()['potentiallySubmitted'][0]['revision'], 2)
        self.assertEqual(self.journal.recover()['autoReprint'], [])


if __name__ == '__main__':
    unittest.main()
