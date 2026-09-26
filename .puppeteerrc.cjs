const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to project root
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
