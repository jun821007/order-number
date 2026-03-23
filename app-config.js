const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.ORDER_TOOL_CONFIG = {
  backend: {
    // 正式站請改成你的 Railway 後端網址
    // 例如: "https://order-tool-backend.up.railway.app"
    baseUrl: isLocal ? "http://localhost:3100" : "https://order-number-production.up.railway.app",
    loadPath: "/api/order-tool/data",
    savePath: "/api/order-tool/data",
    saveMethod: "PUT",
    responseDataField: "",
    requestDataField: "",
    headers: {}
  }
};
