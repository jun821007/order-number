# Order number

單號分類工具（前後端分離）：
- 前端：靜態頁（`index.html` / `styles.css` / `app.js`）
- 後端：Node.js + Express（`backend/server.js`）
- 資料：`data.json`（建議部署在 Railway Volume）

## 建議部署架構

- **GitHub**：程式碼版本控管
- **Railway**：後端 API（讀寫資料）
- **Netlify**：前端 Web App（手機可直接開）

## 本機開發

### 1) 後端

```powershell
cd "C:\Users\rsz97\Order number\backend"
npm install
npm run start
```

預設埠號：`3100`

### 2) 前端

```powershell
cd "C:\Users\rsz97\Order number"
python -m http.server 5500
```

開啟 <http://localhost:5500>

## Railway 發佈（後端）

1. 到 Railway 建立新專案，選 **Deploy from GitHub Repo**
2. 選這個 repo，**Root Directory 設為 `backend`**
3. Railway 會讀 `backend/railway.json`，啟動 `npm run start`
4. 在 Railway 設定環境變數（Variables）：
   - `CORS_ORIGIN=https://你的-netlify-網域.netlify.app`
   - `DATA_DIR=/data`
   - `AUTH_USERNAME=你的登入帳號`
   - `AUTH_PASSWORD_HASH=你的 bcrypt 密碼雜湊`
   - `AUTH_SESSION_SECRET=長隨機字串（至少 32 字元）`
   - （可選）`AUTH_REMEMBER_DAYS=36500`（預設已為永久長效）
   - （可選）`AUTH_COOKIE_SAMESITE=none`（前後端不同網域時必用）
5. 在 Railway 加一個 Volume，掛載路徑設 `/data`
6. 部署完成後記下後端網址，例如：
   - `https://order-tool-backend.up.railway.app`

### 產生密碼雜湊（bcrypt）

在 `backend` 目錄執行：

```powershell
cd "C:\Users\rsz97\Order number\backend"
node -e "const b=require('bcryptjs'); console.log(b.hashSync('你的密碼', 12));"
```

把輸出的字串貼到 Railway 的 `AUTH_PASSWORD_HASH`。

### 淘寶訊息自動同步（選用）

電腦開著淘寶網頁版聊天，外掛會把集運站的訊息送到後端：
- `0.9 單號`（到倉報重量）：已 key 的單號自動入庫並填重量；還沒 key 的先掛在「未分件主」，指定件主後才搬走，未指定前不能出貨
- 多筆 `重量 單號` ＋ `拍N`（出貨報價）：在 App 顯示「待確認出貨」，確認後才出貨；地址訊息會自動帶入

設定：
1. Railway 加環境變數 `INBOX_SECRET=長隨機字串`
2. 電腦 Chrome 安裝 Tampermonkey，安裝 `tools/taobao-inbox.user.js`
3. 打開 `https://market.m.taobao.com/app/im/chat/index.html`，第一次會要求貼上 `INBOX_SECRET`

#### 淘寶桌面版（不用開瀏覽器）

`tools/taobao-desktop-sync.mjs` 透過除錯埠讀淘寶桌面版的聊天頁，只處理「捷豹國際集運站」對話。

1. 工作排程器 `TaobaoDesktopDebug`：登入 Windows 時以 `--remote-debugging-port=9333` 啟動淘寶桌面版
2. 工作排程器 `OrderNumberEnsureTaobao`：同步程式偵測到淘寶關掉時，在桌面工作階段重開（`tools/ensure-taobao-chat.ps1`），並自動打開消息、點進捷豹對話
3. 工作排程器 `OrderNumberTaobaoSync`：登入後 1 分鐘在背景執行同步程式，每 15 秒檢查一次
4. 第一次設定密鑰：`node "C:\Users\rsz97\Order number\tools\taobao-desktop-sync.mjs" --set-secret`
5. 密鑰、已送出紀錄、日誌存在 `%LOCALAPPDATA%\order-number-taobao-sync\`（不進 git）
6. 每 60 分鐘讀一次淘寶「待收貨」訂單，有快遞單號的新訂單自動加到件主「鈞」名下（備註＝商品名前 20 字），排除集運站自己的訂單與虛擬商品；`--orders` 可立即檢查一次
7. 1688：工作排程器 `Order1688Chrome` 開一個同步專用 Chrome（`--remote-debugging-port=9334`，設定檔在 `%LOCALAPPDATA%\order-number-taobao-sync\chrome-1688`），在裡面登入 1688 一次；每 60 分鐘在背景分頁讀「待收货」訂單與物流單號，一樣加到「鈞」名下
8. 捷豹聊天打「付了」之後，同步程式會順便從 Windows 通知抽出中國信託的淘寶消費扣款。台幣掛在待確認出貨上，確認出貨時仍要自己填台幣總額。可單獨跑：`node "C:\Users\rsz97\Order number\tools\ctbc-taobao-notify.mjs"`

### 微信面單入庫（選用）

指定人用微信傳圓通等面單照片（單號多為 `YT…`）時，可半自動入庫到轉運倉。**單號須已先 key 過**；面單通常沒重量，入庫時會保留原重量。

#### 已定案路線（2026-10-17）

- **採用：掛機收訊 + 半自動**（電腦版微信只負責掛著收圖；入庫靠網頁上傳或丟固定資料夾）。
- **不做：讀微信加密聊天 DB／行程抽金鑰全自動**（版本一升易壞、維護高、官方不支援）。若日後要改全自動，需另開 PoC，綁定當下微信大版本再評估。
- 與淘寶桌面 CDP 同步不同路：微信沒有官方除錯埠可穩讀聊天。

**做法 A｜網頁（最快）**
1. 開啟單號分類工具 →「微信面單入庫」
2. 上傳面單照片（條碼／OCR 辨識）或直接貼 `YT…` 單號
3. 按「入庫到轉運倉」

**做法 B｜本機資料夾監看（接近背景同步）**
1. 建立資料夾：`%USERPROFILE%\OrderNumberWeChatLabels`
2. 安裝 OCR：`cd "C:\Users\rsz97\Order number\tools"; npm install`
3. 執行：`node "C:\Users\rsz97\Order number\tools\wechat-label-sync.mjs"`
4. 把微信收到的面單照片另存／拖進該資料夾；程式會辨識 `YT…` 並呼叫 `/api/inbox/labels`
5. 與淘寶同步共用 `%LOCALAPPDATA%\order-number-taobao-sync\` 的 `INBOX_SECRET`

### API 健康檢查

- `GET /health`
- `GET /api/order-tool/data`

## Netlify 發佈（前端）

1. 到 Netlify 新增網站，選 **Import from Git**
2. 指向同一個 GitHub repo，Base directory 留空（根目錄）
3. Build command 留空，Publish directory 設 `.`
4. 部署前，先把根目錄 `app-config.js` 的 `backend.baseUrl` 改成 Railway 網址
5. 重新 Deploy

## GitHub 推送（首次）

在專案根目錄執行：

```powershell
cd "C:\Users\rsz97\Order number"
git init
git add .
git commit -m "chore: prepare github + railway + netlify deployment"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<你的repo>.git
git push -u origin main
```

## 注意事項

- Railway 若不掛 Volume，`data.json` 可能在重啟/重佈署後遺失
- 前端若顯示讀取失敗，多半是 `app-config.js` 的 `baseUrl` 或 `CORS_ORIGIN` 未設定好
- 登入模式啟用後，若帳密錯誤太多次，後端會暫時限制登入請求
- 若手機瀏覽器阻擋第三方 Cookie，前端會自動改用 Bearer Token 備援維持登入
- 目前 API 回傳為純資料物件，不需要 `data` 外層包裝
