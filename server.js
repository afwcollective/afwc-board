'use strict';

const config = require('./src/config');
const { migrate } = require('./src/db');
const app = require('./src/app');

migrate();

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
