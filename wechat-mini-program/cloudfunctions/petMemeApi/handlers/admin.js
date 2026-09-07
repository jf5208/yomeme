const {
  createCodes,
  listCodes,
  disableCode,
} = require("../domain/codes");

async function adminCreateCodes({ db, openid, count, credits, now, randomBytes }) {
  return createCodes({
    db,
    adminOpenid: openid,
    count,
    credits,
    now,
    randomBytes,
  });
}

async function adminListCodes({ db, openid }) {
  return listCodes({ db, adminOpenid: openid });
}

async function adminDisableCode({ db, openid, codeId, now }) {
  return disableCode({ db, adminOpenid: openid, codeId, now });
}

module.exports = {
  adminCreateCodes,
  adminListCodes,
  adminDisableCode,
};
