## 项目概述
宠物 Meme 生成 MVP - 上传 Meme 模板和宠物照片，使用 AI 模型（Gemini/Seedream）生成宠物版 Meme 图片。支持邀请码积分系统和管理员后台。

## 技术栈
- **后端**: Python 3 + Flask 3.1+
- **前端**: HTML + JavaScript + CSS（原生，无框架）
- **AI 集成**: Gemini API、火山方舟 Seedream API
- **依赖管理**: pip + requirements.txt
- **环境变量**: python-dotenv

## 目录结构
```
/workspace/projects/
├── .coze                          # 根配置（平台入口）
├── coze-import-pet-meme-20260903/ # 技术项目根目录
│   ├── .coze                      # 子项目配置
│   ├── run.py                     # 启动入口
│   ├── pet_meme/                  # Flask 应用包
│   │   ├── app.py                 # Flask 应用主逻辑
│   │   ├── generator.py           # AI 图片生成逻辑
│   │   ├── invites.py             # 邀请码系统
│   │   └── prompts.py             # AI 提示词
│   ├── static/                    # 前端静态资源
│   │   ├── index.html             # 用户页面
│   │   ├── admin.html             # 管理员页面
│   │   ├── app.js                 # 用户端 JS
│   │   ├── admin.js               # 管理端 JS
│   │   └── styles.css             # 样式
│   ├── requirements.txt           # 生产依赖
│   ├── requirements-dev.txt       # 开发依赖
│   ├── tests/                     # 测试目录
│   └── docs/                      # 文档
```

## 关键入口 / 核心模块
- **启动入口**: `run.py` - 创建 Flask 应用并启动在 127.0.0.1:18806
- **Flask 应用**: `pet_meme/app.py` - 路由定义、请求处理
- **图片生成**: `pet_meme/generator.py` - 调用 Gemini/Seedream API
- **邀请码系统**: `pet_meme/invites.py` - 邀请码创建、验证、积分管理
- **前端页面**: `static/index.html`（用户）、`static/admin.html`（管理员）

## 运行与预览
- **开发启动**: 
  ```bash
  cd coze-import-pet-meme-20260903
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  cp .env.example .env  # 需要配置 API keys
  python run.py
  ```
- **访问地址**: http://127.0.0.1:5000（用户）、http://127.0.0.1:5000/admin.html（管理员）
- **预览配置**: .preview 文件声明 expose_port = 5000，.coze [dev] 定义构建和运行命令
- **预览型**: ✅ 是 web 项目，支持预览
- **初始化完成**: 2026-09-03，已完成 .coze 配置、部署脚本创建、端口适配（从 .preview 读取端口，绑定 0.0.0.0）

## 用户偏好与长期约束
- 使用 uv 管理 Python 环境（项目级虚拟环境）
- 端口统一从 .preview 读取，不 hardcode
- 对外只暴露 5000 端口

## 常见问题和预防
- **API Key 配置**: 需要在 .env 中配置 GEMINI_API_KEY、ARK_API_KEY、SEEDREAM_MODEL、ADMIN_PASSWORD
- **积分规则**: Seedream 消耗 100 积分，Gemini 消耗 300 积分（按 100 的倍数计算）
- **批量生成邀请码**: 管理员后台支持批量生成（1-100 个），适用于免费体验活动和售卖场景
- **水印处理**: 生成前会自动尝试去除模板角落的平台水印
- **状态记录**: 每次请求记录到 .state/generations.jsonl
- **部署环境状态目录**: FaaS 部署环境文件系统只读，状态目录（uploads、outputs、数据库）默认使用 `/tmp/pet-meme-state`，可通过环境变量 `STATE_DIR` 自定义
