async function callApi(action, payload = {}) {
  const response = await wx.cloud.callFunction({
    name: "petMemeApi",
    data: { action, ...payload },
  });
  const result = response.result || {};
  if (!result.ok) {
    const error = new Error(result.message || "操作失败，请稍后再试。");
    error.code = result.code || "api_error";
    throw error;
  }
  return result;
}

module.exports = { callApi };
