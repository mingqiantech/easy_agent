# Mac Studio M5 Ultra 256GB vs 双路 DGX Spark 对比

> 更新：2026-10-27（对比 Mac vs Spark 单机的前一份文件见 mac-studio-m5-价格规格.md / dgx-spark-视频生成调研）
> 数据来源：Apple 官网、Tom's Hardware M5 Ultra 评测（2026-09，Editor's Choice）、
> mlx.app 对比页（2026-10-19）、multimodalflow.net 双 Spark NCCL 实测（2026-06-19）、
> Contra Collective 实测（2026-10）

## 一句话结论

价格打平（Mac ¥76,999 vs 双 Spark ¥65k–80k），但本质不同：
**Mac = 一台 1.2TB/s 带宽的大机器；双 Spark = 两台被 ~10GB/s NCCL 捆住的小机器 + CUDA 生态。**

---

## 1. 硬参数

| 维度 | Mac Studio M5 Ultra 256GB | 2× DGX Spark |
|---|---|---|
| 国行价 | ¥76,999（1TB SSD） | 约 ¥65,000–80,000（两台） |
| 内存带宽 | **1.2 TB/s**（比 M3 Ultra 819GB/s 高 50%） | 273 GB/s/台，互不相通 |
| 模型可用容量 | 单容器 ~240GB（512GB 档 ~384GB） | ~120GB/台，**跨机不叠加** |
| 机间互联 | 不存在此问题 | 200GbE QSFP 物理；raw ib_write_bw ~197Gb/s，**NCCL 实测 ~10GB/s** |
| CPU/GPU | 36核CPU/80核GPU（256GB 档为 80-core 满血 Ultra） | GB10 ×2（20核Arm/Blackwell GPU FP4） |
| 功耗 | ~270W 峰值 | ~170W × 2 |
| 生态 | MLX/Metal；无 CUDA | **CUDA 全家桶** + NVIDIA 官方 Playbook |

## 2. LLM 推理

- 两边都装得下的模型（27B/32B 级）：Mac 解码吞吐 ≈ Spark 的 **4 倍**
  （带宽主导解码：1.2TB/s ÷ 273GB/s ≈ 4.4；Tom's Hardware / mlx.app 结论一致）
- 单机装不下的大模型（235B+ MoE 级）：双 Spark 跨机 TP 被 NCCL 10GB/s 卡死；
  PP 可行但首 token 延迟翻倍 → 体验仍不如 Mac 单机直接装下
- Apple "4.3×" 官方宣称是 prefill/算力峰值口径，生成侧实测约 1.5–1.9×（insidepc 提醒）

## 3. 视频生成

| | Mac 256GB | 双 Spark |
|---|---|---|
| Wan 2.1/2.2 14B 720p | MLX 版快（带宽吃满） | 官方 Playbook Tier 1，~几分钟/5s |
| 批量并发 | 1 条流水线 | ⚡ 2 条同时跑，产能翻倍 |
| CUDA 特性（TeaCache 官方版/TRT/FP8 节点） | 跟进慢 | 首发支持 |
| 自定义节点兼容 | 常需等 Metal 移植 | 开箱即用 |

## 4. 决策矩阵

| 场景 | 选择 |
|---|---|
| LLM/Agent 为主 | **Mac 256GB**（无悬念） |
| 视频批量流水线出片 | 双 Spark（产能+生态） |
| 视频单条快速迭代 | Mac（MLX Wan 更快） |
| CUDA 开发/微调/学习 | 双 Spark |
| 兼顾剪辑/生产力主机 | Mac |
| 未来横向扩容 | 双 Spark（但受 10GB/s NCCL 天花板限制） |

## 5. 坑

1. **"双 Spark = 256GB" 是幻觉**：权重可以分两机放，激活/层间通信全走 10GB/s NCCL；等效于 ~120GB 单机 + 吞吐翻倍（并行任务时），不等于 256GB 单机
2. Mac 跑 Hunyuan 1080p：装得下（~120GB 峰值 < 240GB 可用）但 MLX 无优化，慢
3. Spark 集群配置门槛：QSFP 线、netplan、免密 SSH、分布式 ComfyUI 编排都是 DIY
4. Mac 无法跑 CUDA-only 的实时玩法（部分 AnimateDiff 变体/ControlNet 预处理节点）

## 6. 用户场景倾向（结合需求档案）

用户画像：Agent 工作流（吃带宽）+ 视频生成（吃生态）+ NAS 远程体系。
- 若 LLM 占比 ≥60% → Mac Studio M5 Ultra 256GB
- 若视频流水线并发 + CUDA 依赖 → 双 Spark
- 折中方案：单 Spark（¥35k 左右）+ 现有 Mac 设备远程协同，省下的钱买 4TB NVMe 和 IP-KVM
