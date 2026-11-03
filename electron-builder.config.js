'use strict';

const path = require('path');
const dotenv = require('dotenv');
const packageJson = require('./package.json');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, 'env') });

const productName = process.env.APP_NAME?.trim() || packageJson.build.productName;

module.exports = {
  ...packageJson.build,
  productName,
  executableName: productName,
  win: {
    ...packageJson.build.win,
    signAndEditExecutable: false,
  },
};
