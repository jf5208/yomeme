const { redeemCode } = require("../domain/codes");

async function redeem({ db, openid, code, now }) {
  return redeemCode({ db, openid, plaintextCode: code, now });
}

module.exports = { redeem };
