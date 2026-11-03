# Jetson设备事实补充

2026-10-31；v0.2-r5。用户对Q00已发设备问题的答复，补充05至08规则，不覆盖02用户原稿和快照。

用户原文：

> 硬件型号NVIDIA NVIDIA Jetson Orin Nano Engineering Reference Developer Ki 操作系统;Ubuntu 22.04.5 LTS 处理器：ARMv8 Processor rev 1 (v8l) × 6

| 字段 | 当前依据 | 使用边界 |
| --- | --- | --- |
| 系列 | 用户报告Jetson Orin Nano | 替代早期不准确的Nano简称，后续适配面向Orin Nano系列 |
| 完整硬件名 | NVIDIA NVIDIA Jetson Orin Nano Engineering Reference Developer Ki | 保留用户提供文本，末尾不自行补全 |
| 操作系统 | Ubuntu 22.04.5 LTS | 用户报告，尚未远程读取设备 |
| CPU | ARMv8 Processor rev 1 (v8l) × 6 | 用户报告，不能只据括号推断完整用户态架构和安装包目标 |
| 内存 | 早期用户报告8GB | 实际可用内存、GPU共享占用及功耗模式待设备实测 |
| JetPack / L4T / CUDA | 本次未提供 | 不能从Ubuntu版本反推具体版本或声称模型/驱动适配成功 |

后续由A05/A06/A07只读取证：设备release、内存和存储、CUDA/JetPack包版本、运行功耗及模型峰值占用。Q00集中维护资料池，已答的系列、OS和CPU不重复询问。此补充不改变先人工确认再打印、自动纠错训练后人工上线、模型不得修改客户价等规则。

本次只更新产品资料；没有登录设备、安装驱动、运行模型、训练、打印或验收设备。
