'use strict';

const config = require('./src/config');
const { migrate, bootstrapRoles } = require('./src/db');

// Migrations run BEFORE src/app.js is required, and that ordering is load
// bearing: the routers prepare their statements at require time, so on a fresh
// volume (a first deploy, or a restore into an empty /data) loading them first
// throws "no such table: threads" and the board dies before anyone can reach
// /setup. Schema first, then the app.
migrate();

// Expire any time-boxed leaders whose term ran out while the app was down, and
// make sure the board has its one architect (see src/db.js). Idempotent.
bootstrapRoles();

const app = require('./src/app');
const { sweepStaleProcessing } = require('./src/services/ingest');

// Ingest only ever runs in this process, so a draft left 'processing' across a
// restart was orphaned by a crash or a redeploy. Mark those failed before we
// start serving, so nobody stares at a spinner that will never resolve.
sweepStaleProcessing();

const server = app.listen(config.port, () => {
  console.log(
    `[afwc] listening on http://localhost:${config.port}  (env=${config.env}, data=${config.dataDir})`
  );
});

function shutdown(signal) {
  return () => {
    console.log(`[afwc] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
}
process.on('SIGINT', shutdown('SIGINT'));
process.on('SIGTERM', shutdown('SIGTERM'));
