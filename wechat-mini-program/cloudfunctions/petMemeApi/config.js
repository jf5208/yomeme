const TRIAL_CREDITS = 300;
const GENERATION_COST = 100;
const RESERVATION_TTL_MS = 10 * 60 * 1000;

function createDatabase(cloud) {
  return cloud.database({ throwOnNotFound: false });
}

module.exports = {
  TRIAL_CREDITS,
  GENERATION_COST,
  RESERVATION_TTL_MS,
  createDatabase,
};
