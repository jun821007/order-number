window.ORDER_TOOL_CONFIG = {
  backend: {
    // 替換成你的 Railway 後端網址
    // 例如: "https://order-tool-backend.up.railway.app"
    baseUrl: "https://your-app.up.railway.app",
    loadPath: "/api/order-tool/data",
    savePath: "/api/order-tool/data",
    saveMethod: "PUT",
    // 目前後端回傳和接收都是純資料物件，不用包 data 欄位
    responseDataField: "",
    requestDataField: "",
    headers: {}
  }
};
