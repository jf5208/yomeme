const { ensureUser } = require("../domain/credits");

async function bootstrap({ db, openid, now }) {
  const user = await ensureUser({ db, openid, now });
  return { credits: user.credits };
}

module.exports = { bootstrap };
