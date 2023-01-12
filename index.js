const Bot = require('keybase-bot'),
  fs = require('fs'),
  cron = require('node-cron');
const username = process.env.KB_USERNAME,
  paperkey = process.env.KB_PAPERKEY,
  teamName = process.env.KB_TEAM_NAME,
  reserveChannelName = process.env.KB_RESERVE_CHANNEL,
  postChannelName = process.env.KB_POST_CHANNEL,
  distroChannelName = process.env.KB_DISTRO_CHANNEL,
  pastWeekLimit = parseInt(process.env.PAST_WEEK_LIMIT),
  dataFile = process.env.DATA_FILE,
  commandPrefix = process.env.COMMAND_PREFIX,
  announcementCron = process.env.ANNOUNCEMENT_CRON,
  purgeCron = process.env.PURGE_CRON,
  showOfHandsCron = process.env.SHOW_OF_HANDS_CRON;

const bot = new Bot();
let data = {};
let reserveChannel,
  postChannel,
  distroChannel;

// TODO: Error handling throughout

async function main() {
  if (fs.existsSync(dataFile)) {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  }

  try {
    await bot.init(username, paperkey, {verbose: false});
    console.log(`Reservation bot is initialized. It is logged in as ${bot.myInfo().username}`);

    const convs = await bot.chat.listChannels(teamName);
    const channels = convs.map(c => {return c.channel});
    reserveChannel = channels.filter(c => c.topicName === reserveChannelName)[0];
    postChannel = channels.filter(c => c.topicName === postChannelName)[0];
    distroChannel = channels.filter(c => c.topicName === distroChannelName);

    await bot.chat.send(postChannel, 
      {body: 'Hi, all! I will periodically be posting schedule updates in this channel.'}
    );
    cron.schedule(announcementCron, displayPeriodicUpdate);
    cron.schedule(purgeCron, purgeOldRecords);
    cron.schedule(showOfHandsCron, distroShowOfHands)
    await bot.chat.watchChannelForNewMessages(reserveChannel, onMessage, onError);
  } catch (error) {
    console.error(error)
  } finally {
    await bot.deinit()
  }
}

async function displayPeriodicUpdate() {
  try {
    let responseBody = `Reservations for next week:\n`;
    let haveDistro = false;
    let haveCooking = false;
    for (const r of data.reservations) {
      const timeAfterNow = new Date(r.date).getTime() - new Date().getTime();
      if (timeAfterNow > 0 && timeAfterNow < 7 * 24 * 60 * 60 * 1000) {
        responseBody += `${r.user}: ${r.type} on ${new Date(r.date).toDateString()}\n`;
        if (r.type === 'cooking') {
          haveCooking = true;
        } else if (r.type === 'distro') {
          haveDistro = true;
        }
      }
    }
    await bot.chat.send(postChannel, {
      body: responseBody,
    });
    if (!haveCooking || !haveDistro) {
      await bot.chat.send(postChannel, {
        body: `We could still use volunteers for next week. Please post in ${reserveChannelName} to volunteer.`
      })
    }
  } catch (err) {
    console.log(err);
    await bot.chat.send(postChannel, {
      body: `Failed to display update, see logs for details.`
    })
  }
}

async function distroShowOfHands() {
  await bot.chat.send(postChannel, {
    body: `Show of hands for distro this week?`,
  });
}

async function displaySchedule(conversationId) {
  try {
    let responseBody = `Reservations:\n`
    for (const r of data.reservations) {
      responseBody += `${r.user}: ${r.type} on ${new Date(r.date).toDateString()}\n`;
    }
    await bot.chat.send(conversationId, {
      body: responseBody,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(conversationId, {
      body: `Failed to display schedule, see logs for details.`
    })
  }
}

async function makeReservation(message) {
  try {
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
      (new Date(r.date).getTime() === newReservation.date.getTime() &&
        r.type === newReservation.type));
    if (conflictingReservations.length > 0) {
      const c = conflictingReservations[0];
      console.log(`Existing reservation ${JSON.stringify(c)} conflicts with new reservation ${JSON.stringify(newReservation)}`);
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
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to make reservation, see logs for details.`
    })
  }
}

async function makeReservationForOther(message) {
  try {
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
        body: 'This is not a reservation type I recognize. I will make the reservation, please delete it if it was made in error',
      });
    }
    const conflictingReservations = data.reservations.filter(r => 
      (new Date(r.date).getTime() === newReservation.date.getTime() &&
        r.type === newReservation.type));
    if (conflictingReservations.length > 0) {
      const c = conflictingReservations[0];
      console.log(`Existing reservation ${JSON.stringify(c)} conflicts with new reservation ${JSON.stringify(newReservation)}`);
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
      body: 'Reservation made.',
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to make reservation, see logs for details.`
    })
  }
}

async function deleteReservation(message) {
  try {
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
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to delete reservation, see logs for details.`
    })
  }
}

async function makeAdmin(message) {
  try {
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
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to make user admin, see logs for details.`
    })
  }
}

async function removeAdmin(message) {
  try {
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
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to remove admin privileges, see logs for details.`
    })
  }
}

async function deleteAll(message) {
  try {
    const user = message.sender.username;
    if (!data.admins.includes(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to delete all scheduled reservations`,
      });
      return;
    }
    const numRecords = data.reservations.length;
    data.reservations = [];
    fs.writeFileSync(dataFile, JSON.stringify(data));
    await bot.chat.send(message.conversationId, {
      body: `Deleted ${numRecords} records`,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to delete all reservations, see logs for details.`
    })
  }
}

async function killBot(message) {
  const user = message.sender.username;
  if (!data.admins.includes(user)) {
    await bot.chat.send(message.conversationId, {
      body: `You do not have permissions to kill the bot`,
    });
    return;
  }
  await bot.chat.send(message.conversationId, {
    body: `Shutting down`,
  });
  process.exit();
}

async function listAdmins(conversationId) {
  try {
    let responseBody = `Admins:\n`
    for (const r of data.admins) {
      responseBody += `${r}\n`;
    }
    await bot.chat.send(conversationId, {
      body: responseBody,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(conversationId, {
      body: `Failed to list admins, see logs for details.`
    })
  }
}

async function displayHelp(conversationId) {
  await bot.chat.send(conversationId, {
    body: 
`Usage:
!reservation-bot list -- list all reservations
!reservation-bot make <date> <type> -- make a reservation
!reservation-bot delete <date> <type> -- delete a reservation
This bot is a work in progress and does not yet have complete documentation. Contact aeou1324 for help`,
  });
}

async function onMessage(message) {
  if (message.content.text.body.split(' ')[0] !== commandPrefix) {
    return;
  }
  switch (message.content.text.body.split(' ')[1]) {
    case 'list':
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
    case 'delete-all':
      await deleteAll(message);
      break;
    case 'kill':
      await killBot(message);
      break;
    default:
      await bot.chat.send(message.conversationId, {
        body: `I didn't recognize that request`,
      });
  }
}

function purgeOldRecords() {
  try {
    const initialRecords = data.reservations.length;
    let cutoff = new Date();
    cutoff.setDate(new Date().getDate() - 7 * pastWeekLimit);
    data.reservations = data.reservations.filter(r => new Date(r.date).getTime() > cutoff.getTime());
    fs.writeFileSync(dataFile, JSON.stringify(data));
    console.log(`Purged ${initialRecords - data.reservations.length} records`);
  } catch (err) {
    console.log("Failed to purge old records", err);
  }
}

async function onError(err) {
  console.log(err);
}

main()