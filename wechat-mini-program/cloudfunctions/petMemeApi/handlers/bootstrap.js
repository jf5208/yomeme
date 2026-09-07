const { ensureUser } = require("../domain/credits");
const { recoverCallerStaleJobs: recoverCaller } = require("./recover");

async function bootstrap({
  db,
  openid,
  now,
  recoverCallerStaleJobs = recoverCaller,
}) {
  await ensureUser({ db, openid, now });
  await recoverCallerStaleJobs({ db, openid, now });
  const user = await ensureUser({ db, openid, now });
  return { credits: user.credits };
}

module.exports = { bootstrap };
