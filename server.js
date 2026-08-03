'use strict';

const config = require('./src/config');
const { migrate } = require('./src/db');
const app = require('./src/app');
const { sweepStaleProcessing } = require('./src/services/ingest');

migrate();

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
