const dotenv = require('dotenv');username
dotenv.config();

module.exports = {
  username:process.env.KB_USERNAME,
  paperkey:process.env.KB_PAPERKEY,
  teamName:process.env.KB_TEAM_NAME,
  reserveChannelName:process.env.KB_RESERVE_CHANNEL,
  postChannelName:process.env.KB_POST_CHANNEL,
  commandPrefix:process.env.COMMAND_PREFIX,
  dbUser:process.env.DB_USER,
  dbPass:process.env.DB_PASS,
  dbHost:process.env.DB_HOST,
  dbPort:process.env.DB_PORT,
  dbName:process.env.DB_NAME
}