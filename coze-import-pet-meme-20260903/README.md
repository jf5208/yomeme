# 宠物 Meme 生成 MVP

这是一个本机网页 MVP：上传 1 张单动物 Meme 模板图和 1 到 3 张自家宠物照片，尽量保留原 Meme 的文字、构图、动作神态和低清网图质感，只替换动物主体。

## 本机启动

```bash
cd /Users/janetshi/.codex/.chatgpt-projects/g-p-6a6b3e93a14c8191a0d4508be1304e13/pet-meme-mvp
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
cp .env.example .env
open -e .env
python3 run.py
```

在 [Google AI Studio](https://aistudio.google.com/apikey) 创建 Gemini API Key，或在火山方舟创建 API Key。`.env` 需要配置：

- `GEMINI_API_KEY`
- `ARK_API_KEY`
- `SEEDREAM_MODEL`
- `ADMIN_PASSWORD`

启动后打开用户入口：

```text
http://127.0.0.1:18806
```

管理员入口：

```text
http://127.0.0.1:18806/admin.html
```

管理员使用 `ADMIN_PASSWORD` 创建邀请码，可选择 Gemini 或 Seedream，并设置积分数量。新邀请码默认 10 积分。

## 使用方式

用户页当前只支持邀请码：

- 输入管理员创建的邀请码，验证后会显示分配模型和剩余积分。

邀请码积分规则：

- Seedream 成功生成图片消耗 1 积分。
- Gemini 成功生成图片消耗 3 积分。
- 生成失败会退回本次占用的积分。
- 输入调整意见后重新生成，会再发起一次生成请求，并按模型再次消耗积分。
- 生成前需要确认上传素材为本人创作或已获授权；确认后会自动尝试去除模板角落的平台水印。

## 当前边界

- 只支持单动物 Meme 模板。
- 宠物参考图支持 1 到 3 张。
- 支持首次生成和一次输入调整意见后的再次生成。
- 不做计费、社区、登录、多动物、复杂局部编辑或长期素材库。
- 邀请码绑定 Gemini 或 Seedream；用户不能在页面切换模型。
- 支持本机邀请码积分管理，但支付、账号系统和公开部署仍不在 MVP 范围内。
- 每次请求会把模型、时间和成功状态记录到 `.state/generations.jsonl`。
- 模型会尽量保留原图文字和质感，但不能保证像素级不变。

## 开发验证

```bash
python3 -m pip install -r requirements-dev.txt
python3 -m pytest tests -q
```
