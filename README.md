# Speech To Text System

一个基于 Vue 3 + FastAPI + PostgreSQL 的语音平台，支持中文、日语、英文语音自动识别并转写为文本，也支持文本生成语音。上传页面采用上下布局：上方为文件上传区域，下方为转写结果区域，支持将转写结果导出为 Word 文档。系统提供用户注册、细粒度权限控制、批量上传、转写任务队列、审计日志和更完整的文件管理能力。

## 技术栈

- 前端：Vue 3、Vite、Pinia、Vue Router
- 后端：Python、FastAPI、SQLAlchemy
- 数据库：PostgreSQL（本地连接）
- 语音识别：faster-whisper
- URL 媒体解析：yt-dlp
- 文档导出：python-docx

## 核心能力

- 用户登录后上传音频文件
- 用户可自行注册账户
- 自动检测中文、日语、英文语音并生成文本
- 支持上传常见音频和视频格式，视频会自动抽取音轨后转写
- 支持输入媒体 URL 解析远程音视频，页面内直接播放并同步高亮转写文本
- URL 转写支持按需翻译为中文、日语、英语，并可随下载文本一并导出翻译内容
- 支持单文件和批量文件入队转写
- 支持队列式异步转写、失败重试和文件删除
- 下方结果区展示当前转写文本和历史记录
- 允许下载 `.docx` Word 文档
- URL 转写结果支持下载 `.txt` 文本
- 支持文本或文档生成语音，可选 `mp3`、`wav`、`m4a` 下载格式
- 中文、日语优先语音可通过环境变量配置
- 管理员可按权限管理用户、文件、设置和审计日志
- 支持细粒度权限：上传、文件管理、用户管理、设置管理、审计查看
- 管理员配置最大上传文件大小（MB）
- 数据持久化到本地 PostgreSQL，不使用 SQLite

## 目录结构

```text
backend/   FastAPI + PostgreSQL + Whisper
frontend/  Vue 3 + Vite
```

## 本地环境要求

1. 已安装 PostgreSQL，并确保本机可访问。
2. 已安装 Python 3.11 或更高版本。
3. 已安装 Node.js 20 或更高版本。
4. 首次转写时需要联网下载 Whisper 模型。
5. 使用 URL 解析转写时，需要目标站点可被 `yt-dlp` 正常访问和下载。
6. 若部分 YouTube 链接触发人机验证，后端会自动尝试读取本机 Edge、Chrome、Brave、Firefox 的浏览器 Cookie 进行回退下载。
7. 在 Windows 上如果 Chromium 浏览器触发 DPAPI 解密失败，可在 `backend/.env` 中配置 `YOUTUBE_COOKIES_PATH` 指向手工导出的 YouTube `cookies.txt`。
8. YouTube 新版 JS challenge 需要 `yt-dlp-ejs` 与 Node.js runtime 配合；按 `backend/requirements.txt` 安装依赖后即可满足，部署环境不要省略 Node.js。

## PostgreSQL 准备

先在本地 PostgreSQL 中创建数据库和可连接用户，应用默认使用独立 schema `speech_app` 来避免 `public` schema 权限不足：

```powershell
createdb -U postgres speech_to_text
psql -U postgres -d speech_to_text -c "CREATE USER speech_user WITH PASSWORD 'speech_password';"
psql -U postgres -d speech_to_text -c "GRANT CONNECT, CREATE ON DATABASE speech_to_text TO speech_user;"
```

如果你的 PostgreSQL 用户名、密码或端口不同，请修改 [backend/.env.example](backend/.env.example) 中的连接字符串，并复制为 `backend/.env`：

```env
DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/speech_to_text
DATABASE_SCHEMA=speech_app
PREFERRED_ZH_VOICE=zh-CN-XiaoxiaoNeural
PREFERRED_JA_VOICE=ja-JP-NanamiNeural
YOUTUBE_COOKIES_PATH=
```

## 后端启动

在 `backend` 目录执行：

```powershell
cd backend
python -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000
```

后端启动时会自动：

- 创建数据库表
- 自动创建 `speech_app` schema
- 初始化默认管理员账户
- 初始化最大上传文件大小设置
- 创建上传目录和生成语音目录

默认管理员账号：

- 用户名：`admin`
- 密码：`admin123456`

可在 [backend/.env.example](backend/.env.example) 中修改默认值。

## 前端启动

在 `frontend` 目录执行：

```powershell
cd frontend
npm install
npm run dev
```

默认前端地址：`http://localhost:5173`

## 使用说明

1. 新用户可先注册，再登录系统。
2. 在语音转文本上传单个或多个音频或视频文件。
3. 系统自动将任务放入队列，后台依次识别语言并生成文本。
4. 在 URL 转写页面输入视频或音频链接，系统会解析媒体、展示播放器，并在播放时同步高亮文本片段。
5. URL 转写完成后可切换翻译语言、删除最近履历，也可以点击某个时间片段快速跳转播放位置。
6. 下载 URL 文本时会跟随翻译开关，按需附带翻译结果导出。
7. 如果 YouTube 仍提示需要登录验证，请先在本机浏览器中登录 YouTube，必要时关闭浏览器后再重新提交链接；如果是 Windows 下 Chromium 的 DPAPI 解密失败，建议改用 Firefox 登录态或配置 `YOUTUBE_COOKIES_PATH`。
8. 如果 YouTube 链接在已配置 Cookie 的情况下仍报 JS challenge 相关错误，请确认部署机器已安装 Node.js 20+，并重新执行一次 `pip install -r backend/requirements.txt`。
9. 在文本生成语音页面输入文本或上传文档，选择风格和输出格式后生成语音，可试听、下载、删除。
10. 在下方历史记录中查看状态、错误、批次号，并执行下载、重试、删除。
11. 管理员进入管理区域管理用户权限、调整最大上传大小并查看审计日志。

## 接口概览

- `POST /api/auth/register` 用户注册
- `POST /api/auth/login` 用户登录
- `GET /api/auth/me` 当前用户信息
- `GET /api/transcriptions` 查询上传记录
- `GET /api/transcriptions/{id}` 查询单条上传记录
- `POST /api/transcriptions/upload` 单文件入队
- `POST /api/transcriptions/batch-upload` 批量文件入队
- `POST /api/transcriptions/url` 根据 URL 解析远程音视频并入队转写
- `GET /api/transcriptions/{id}/download` 下载 Word 文档
- `GET /api/transcriptions/{id}/download-text` 下载纯文本转写结果
- `GET /api/transcriptions/{id}/translation?target_language=zh|ja|en` 获取 URL 转写结果的按需翻译文本
- `GET /api/transcriptions/{id}/media?token=...` 在页面中播放音视频媒体
- `POST /api/transcriptions/{id}/retry` 重新入队
- `DELETE /api/transcriptions/{id}` 删除文件记录和物理文件
- `GET /api/speech-generations` 查询语音生成记录
- `POST /api/speech-generations/generate` 生成语音
- `GET /api/speech-generations/{id}/audio` 在线播放音频
- `GET /api/speech-generations/{id}/download` 下载音频文件
- `DELETE /api/speech-generations/{id}` 删除语音记录和文件
- `GET /api/admin/users` 管理员查询用户
- `POST /api/admin/users` 管理员创建用户
- `PUT /api/admin/users/{id}` 管理员更新用户
- `DELETE /api/admin/users/{id}` 管理员删除用户
- `GET /api/admin/settings/upload` 读取上传大小设置
- `PUT /api/admin/settings/upload` 更新上传大小设置
- `GET /api/admin/audit-logs` 查看审计日志

## 说明

- `faster-whisper` 首次加载模型时会比后续请求更慢。
- 任务队列为单进程本地队列，适合单机部署；如需横向扩展，建议后续替换为 Celery/RQ。
- 当前后端配置使用 CPU 推理，适合本地部署和开发环境。
- 如果需要更快推理速度，可以在具备条件时将 Whisper 模型改为更小或使用 GPU 环境。
