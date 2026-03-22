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
5. 在 Railway 加一個 Volume，掛載路徑設 `/data`
6. 部署完成後記下後端網址，例如：
   - `https://order-tool-backend.up.railway.app`

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
- 目前 API 回傳為純資料物件，不需要 `data` 外層包裝
