const Bot = require('keybase-bot'),
  fs = require('fs');
const username = process.env.KB_USERNAME,
  paperkey = process.env.KB_PAPERKEY,
  teamName = process.env.KB_TEAM_NAME,
  reserveChannelName = process.env.KB_RESERVE_CHANNEL,
  postChannelName = process.env.KB_POST_CHANNEL,
  pastWeekLimit = parseInt(process.env.PAST_WEEK_LIMIT),
  dataFile = process.env.DATA_FILE;

const bot = new Bot();
let data = {};

async function main() {
  if (fs.existsSync(dataFile)) {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  }

  try {
    await bot.init(username, paperkey, {verbose: false});
    console.log(`Reservation bot is initialized. It is logged in as ${bot.myInfo().username}`);

    const convs = await bot.chat.listChannels(teamName);
    const channels = convs.map(c => {return c.channel});
    const reserveChannel = channels.filter(c => c.topicName === reserveChannelName)[0];
    const postChannel = channels.filter(c => c.topicName === postChannelName)[0];

    await bot.chat.send(postChannel, {body: 'The bot will post announcements here'});
    await bot.chat.watchChannelForNewMessages(reserveChannel, onMessage, onError);
  } catch (error) {
    console.error(error)
  } finally {
    await bot.deinit()
  }
}

async function displaySchedule(conversationId) {
  let responseBody = `Reservations:\n`
  for (const r of data.reservations) {
    responseBody += `${r.user}: ${r.type} on ${new Date(r.date).toDateString()}\n`;
  }
  await bot.chat.send(conversationId, {
    body: responseBody,
  });
}

async function makeReservation(message) {
  let newReservation = {
    date: new Date(message.content.text.body.split(' ')[2]),
    user: message.sender.username,
    type: message.content.text.body.split(' ')[3]
  }
  if (!data.known_types.includes(newReservation.type)) {
    await bot.chat.send(message.conversationId, {
      body: 'This is not a reservation type I recognize. Was it a typo?',
    });
  }
  const conflictingReservations = data.reservations.filter(r => 
    (new Date(r.date).getTime() === newReservation.date.getTime() ||
      r.type === newReservation.type));
  if (conflictingReservations.length > 0) {
    const c = conflictingReservations[0];
    bot.chat.send(message.conversationId, {
      body: `This slot is already reserved:
      ${c.user}: ${c.type} on ${new Date(c.date).toDateString()}.
      Delete this reservation first if you wish to replace it.`,
    });
    return;
  }
  data.reservations.push(newReservation);
  fs.writeFileSync(dataFile, JSON.stringify(data));
  await bot.chat.send(message.conversationId, {
    body: 'Reservation made',
  });
}

async function makeReservation(message) {
  const user = message.sender.username;
  if (!data.admins.includes(user)) {
    await bot.chat.send(message.conversationId, {
      body: `You do not have permissions to make reservations for other users`,
    });
    return;
  }
  let newReservation = {
    date: new Date(message.content.text.body.split(' ')[2]),
    user: message.content.text.body.split(' ')[4],
    type: message.content.text.body.split(' ')[3]
  }
  if (!data.known_types.includes(newReservation.type)) {
    await bot.chat.send(message.conversationId, {
      body: 'This is not a reservation type I recognize. Was it a typo?',
    });
  }
  const conflictingReservations = data.reservations.filter(r => 
    (new Date(r.date).getTime() === newReservation.date.getTime() ||
      r.type === newReservation.type));
  if (conflictingReservations.length > 0) {
    const c = conflictingReservations[0];
    bot.chat.send(message.conversationId, {
      body: `This slot is already reserved:
      ${c.user}: ${c.type} on ${new Date(c.date).toDateString()}.
      Delete this reservation first if you wish to replace it.`,
    });
    return;
  }
  data.reservations.push(newReservation);
  fs.writeFileSync(dataFile, JSON.stringify(data));
  await bot.chat.send(message.conversationId, {
    body: 'Reservation made',
  });
}

async function deleteReservation(message) {
  const date = new Date(message.content.text.body.split(' ')[2]);
  const user = message.sender.username;
  const type = message.content.text.body.split(' ')[3];
  let deletedCount = 0;
  let remainingReservations = [];
  for (const r of data.reservations) {
    if (new Date(r.date).getTime() !== date.getTime() || r.type !== type) {
      remainingReservations.push(r);
      continue;
    }
    if (r.user === user || data.admins.includes(user)) {
      deletedCount += 1;
      continue;
    } else {
      remainingReservations.push(r);
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to delete reservation:
        ${r.user}: ${r.type} on ${new Date(r.date).toDateString()}.
        Please contact an admin to delete it.`,
      });
    }
  }
  data.reservations = remainingReservations;
  fs.writeFileSync(dataFile, JSON.stringify(data));
  await bot.chat.send(message.conversationId, {
    body: `Deleted ${deletedCount} reservations.`,
  });
}

async function makeAdmin(message) {
  const user = message.sender.username;
  if (!data.admins.includes(user)) {
    await bot.chat.send(message.conversationId, {
      body: `You do not have permissions to grant admin status`,
    });
    return;
  }
  const toAdd = message.content.text.body.split(' ')[2];
  data.admins.push(toAdd);
  fs.writeFileSync(dataFile, JSON.stringify(data));
  await bot.chat.send(message.conversationId, {
    body: `Made ${toAdd} an admin`,
  });
}

async function removeAdmin(message) {
  const user = message.sender.username;
  if (!data.admins.includes(user)) {
    await bot.chat.send(message.conversationId, {
      body: `You do not have permissions to revoke admin status`,
    });
    return;
  }
  toRemove = message.content.text.body.split(' ')[2]
  if (!data.admins.includes(toRemove)) {
    await bot.chat.send(message.conversationId, {
      body: `${toRemove} was not an admin`,
    });
  } else {
    data.admins = data.admins.filter(a => a !== toRemove);
    fs.writeFileSync(dataFile, JSON.stringify(data));
    await bot.chat.send(message.conversationId, {
      body: `${toRemove} is no longer an admin`,
    });
  }
}

async function listAdmins(conversationId) {
  let responseBody = `Admins:\n`
  for (const r of data.admins) {
    responseBody += `${r}\n`;
  }
  await bot.chat.send(conversationId, {
    body: responseBody,
  });
}

async function displayHelp(conversationId) {
  await bot.chat.send(conversationId, {
    body: `This bot is a work in progress and does not yet have a README. Contact aeou1324 for help`,
  });
}

async function onMessage(message) {
  if (message.content.text.body.split(' ')[0] !== '/bot') {
    return;
  }
  switch (message.content.text.body.split(' ')[1]) {
    case 'existing':
      await displaySchedule(message.conversationId);
      break;
    case 'make':
      await makeReservation(message);
      break;
    case 'make-for-other':
      await makeReservationForOther(message);
      break;
    case 'delete':
      await deleteReservation(message);
      break;
    case 'make-admin':
      await makeAdmin(message);
      break;
    case 'remove-admin':
      await removeAdmin(message);
      break;
    case 'list-admins':
      await listAdmins(message.conversationId);
      break;
    case 'help':
      await displayHelp(message.conversationId);
      break
    default:
      await bot.chat.send(message.conversationId, {
        body: `I didn't recognize that request`,
      });
  }
}

async function onError(err) {
  console.log(err);
}

main()