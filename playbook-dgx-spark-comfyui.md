# DGX Spark 视频生成部署清单（ComfyUI 官方 Playbook 改编）

> 依据：https://build.nvidia.com/playbooks/comfyui.md（curl 可取全文，浏览器页是 JS 壳）
> 仓库：https://github.com/NVIDIA/dgx-spark-playbooks → `nvidia/playbook-comfyui`
> 适用：DGX Spark（DGX OS，128GB 统一内存）；镜像同样兼容 DGX Station / RTX PRO 6000 Blackwell / Mac（官方声明，Mac 需降档）

---

## 1. 模型档位与 Spark 适配判断

| Tier | 模型 | 磁盘 | 峰值显存（官方） | Spark 128GB 判断 |
|---|---|---|---|---|
| **1 入门** | FLUX.1 dev + **Wan 2.1 T2V 14B** | ~70 GB | ~80 GB（Wan 720p 片段） | ✅ 舒适区，主力档位 |
| **2 进阶** | + HiDream-I1、Wan 2.1 I2V、Cosmos-Predict2 | ~180 GB | ~100 GB（FLUX→Wan 双模型图） | ⚠️ 能跑，I2V 建议先低帧数试 |
| **3 高级** | + HunyuanVideo、FLUX ControlNet(Canny) | ~230 GB | ~120 GB（Hunyuan 1080p） | ❌ Hunyuan 顶格，**跳过**（社区共识：Spark 上不值得）；ControlNet 可用 |

**官方对统一内存平台的提示**：大视频模型需降分辨率或帧数（原话："On unified-memory platforms, large video models may need reduced resolution or frames"）。

### Spark 上的实际推荐组合（官方 Tier + 社区优化）
- **出图**：FLUX.1 dev（Tier 1 自带，15–30 秒/张）
- **出视频主力**：Wan 2.1/2.2 T2V 14B，**480p–720p / 33–81 帧**（官方默认 720p×81f≈5s，几分钟一条）
- **快速预览/迭代**：**Wan 2.1 1.3B** 或 **Wan 2.2 5B TI2V**（社区方案，需手动加模型文件，不在官方 tier 下载脚本内）
- **1080p**：官方 Tier 3 是 Hunyuan（Spark 顶格）；社区方案是 Wan 2.2 5B 直接 720p@24fps，1080p 留给"最后升格"离线跑

## 2. 磁盘规划

| 项目 | 大小 |
|---|---|
| Docker 镜像（NGC PyTorch + ComfyUI + 自定义节点） | ~30 GB |
| Tier 1 模型 | ~70 GB |
| Tier 2 全量 | ~180 GB |
| Tier 3 全量 | ~230 GB |
| 输出 + HF 缓存冗余 | ~50 GB |

**建议**：全部 3 档都装 ≈ **310 GB**，4TB 外置 NVMe 绰绰有余；把 playbook 仓库 clone 到 4TB 盘上，`models/` 自然落在外置盘，别占 Spark 内置 1TB。

## 3. 部署步骤（官方 9 步浓缩）

```bash
# Step 1 环境检查：GPU 可见、Docker 24+、磁盘足够
nvidia-smi && docker --version && df -h /
sudo usermod -aG docker $USER && newgrp docker

# Step 2 HF 凭证（gated 模型必须在 HF 网页先接受许可：FLUX.1 dev / HiDream-I1）
export HF_TOKEN="***"

# Step 3 克隆并构建镜像（5–10 分钟）
git clone https://github.com/NVIDIA/dgx-spark-playbooks
cd dgx-spark-playbooks/nvidia/playbook-comfyui
docker build -t comfyui -f assets/Dockerfile .

# Step 4 按档下载模型（脚本放同一 shell 跑，用 HF_TOKEN）
pip3 install --break-system-packages huggingface-hub
bash assets/scripts/download-models.sh 1     # Tier 1；不带参数 = 全档
ls -la ./models/diffusion_models/ ./models/text_encoders/

# Step 5 启动容器（单卡 Spark 用 --gpus all 即可）
docker run -d --name comfyui \
  --gpus all --ipc host --ulimit memlock=-1 \
  -p 8188:8188 \
  -v "$(pwd)/models:/opt/ComfyUI/models" \
  -v "$(pwd)/output:/opt/ComfyUI/output" \
  -v "$(pwd)/input:/opt/ComfyUI/input" \
  -v "$(pwd)/assets/workflows:/opt/ComfyUI/user/default/workflows" \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  comfyui
docker logs -f comfyui   # 就绪标志：To see the GUI go to: http://0.0.0.0:8188
curl -I http://localhost:8188   # 期望 HTTP 200
```

浏览器打开 `http://<Spark_IP>:8188`：
- **文生图**：加载 `flux-text-to-image.json` → CLIP Text Encode 填提示词 → Queue Prompt
- **文生视频**：加载 `wan-text-to-video.json`（默认 720p×81f，几分钟）
- 产物为动画 WEBP，转 MP4：`ffmpeg -i out.webp -movflags +faststart out.mp4`

## 4. 优化与坑

**性能优化**
1. **迭代用低档，成品用高档**：480p/33f 试 prompt，满意后 720p/81f 出片
2. **Wan 2.2 双模型（14B high/low noise）**：手动把模型放进 `models/diffusion_models/`，配 KJNodes 按 timestep 切换；比 2.1 质量更好、步数更少
3. **显存吃紧时**：fp8 权重 / GGUF Q4–Q5 / TGWQ cache（k_j=5）——社区实测在 Spark 上可把 720p 长片段压进内存
4. **TeaCache**：官方 playbook 自带 TeaCache 视频节点，开着可提速 ~20%

**坑（均来自官方 NOTE）**
- `assets/workflow_api/*.api.json` 是给 HTTP API 用的，**在 UI 里 Load 会报 "workflow does not contain any nodes"**——正常现象，别排查
- 启动日志里的 CUDA-hooks / 版本警告是**良性的**，只认 "To see the GUI go to" 这一行
- 容器以 root 写文件会污染宿主目录；避免方法：`docker run --user "$(id -u):$(id -g)" ...`
- Windows WSL2 跑 DGX Station 时 HiDream 会报 VBAR 分配失败，需 `--disable-dynamic-vram`——**Spark 原生 DGX OS 无此问题**
- 自动化出图：`POST /prompt` 提交 `workflow_api/*.api.json`（官方示例用 python 提取数字 key 后 curl）

## 5. 验收标准（官方 agent 指令原文）

> "When finished, state clearly whether the playbook succeeded, and give the evidence: what you installed, where, and the output of a command proving it works."

证据三件套：`curl -I http://localhost:8188` 返回 200 + FLUX 出图（15–30s）+ Wan 出 720p/81f 视频（数分钟）。

---

*另：官方 playbook 提供 "Install with an agent" 模式——把
`https://build.nvidia.com/playbooks/comfyui.md` 这个 URL 直接丢给 OpenCode/Codex 等编码 agent
（官方测试用的是 Qwen3.6 35B A3B NVFP4），agent 可全程自动执行本手册。*
