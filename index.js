const Bot = require('keybase-bot'),
  cron = require('node-cron'),
  mysql = require('promise-mysql'),
  config = require('./config'),
  utils = require('./utils'),
  oneWeek = 7 * 24 * 60 * 60 * 1000;

let bot = new Bot(),
  reserveChannel,
  postChannel,
  conn;

function main() {
  initialize();
}

async function initialize() {
  try {
    await bot.init(config.username, config.paperkey, {verbose: false});
    console.log(`Reservation bot is initialized. It is logged in as ${bot.myInfo().username}`);

    conn = await mysql.createConnection({
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPass,
      database: config.dbName
    })

    const convs = await bot.chat.listChannels(config.teamName);
    const channels = convs.map(c => {return c.channel});
    reserveChannel = channels.filter(c => c.topicName === config.reserveChannelName)[0];
    postChannel = channels.filter(c => c.topicName === config.postChannelName)[0];

    const announcements = await conn.query('SELECT * FROM announcements;');
    for (const m of announcements) {
      cron.schedule(m.cron, scheduleAnnouncement(m));
    }
    await bot.chat.send(reserveChannel, 
      {body: `Reservation bot has started. I will listen for requests in this channel.`
    });
    await bot.chat.watchChannelForNewMessages(reserveChannel, onMessage, onError);
  } catch (error) {
    console.error(error)
  } finally {
    await bot.deinit()
  }
}

function parseArgs (message) {
  const args = message.content.text.body.split(':')[1].split(';')
  const retVal = [];
  for (const a of args) {
    retVal.push(a.trim());
  }
  return retVal;
}

async function getTypes(type) {
  let retVal = [];
  if (!['known', 'expected'].includes(type)) {
    console.error("Invalid query type", type);
    return retVal;
  }
  try {
    if (type === 'known') {
      const res = await conn.query('SELECT name FROM known_types;');
      for (const r of res) {
        retVal.push(r.name);
      }
    } else {
      retVal = await conn.query('SELECT * FROM expected_types')
    }
  } catch (err) {
    console.error("Failed to query for types", err);
  }
  return retVal;
}

async function isAdmin(user) {
  const res = await conn.query('SELECT keybase_name FROM admins WHERE keybase_name = ?;', [user]);
  return res.length == 1;
}

async function getReservations(from, to) {
  try {
    const retVal = await conn.query('SELECT * FROM reservations WHERE date BETWEEN ? AND ?;',
    [from.toISODate(), to.toISODate()]);
    return retVal
  } catch (err) {
    console.error("Failed to query for reservations", err);
    return [];
  }
}

function scheduleAnnouncement(announcement) {
  console.log("Scheduling announcement", announcement);
  return async () => {
    try {
      const expectedTypes = await getTypes('expected');
      const reservations = await getReservations(new Date(), new Date(Date.now() + oneWeek));
      let responseBody = announcement.text + `\n`;
      if (announcement.include_schedule) {
        for (const t of expectedTypes) {
          t.haveNextWeek = false;
        }
        for (const r of reservations) {
          responseBody += `${r.user}: ${r.type} on ${new Date(r.date).toDateString()}\n`;
          for (const t of expectedTypes) {
            if (r.type === t.name) {
              t.have_next_week = true;
            }
          }
        }
        if (announcement.request_volunteers) {
          responseBody += `\n`;
          for (const t of expectedTypes) {
            if (!t.have_next_week) responseBody += t.message_if_none + `\n`;
          }
        }
      }
      await bot.chat.send(postChannel, {
        body: responseBody,
      });
    } catch (err) {
      console.log(err);
      await bot.chat.send(postChannel, {
        body: `Failed to display update, see logs for details.`
      })
    }
  }
}

async function displaySchedule(conversationId) {
  try {
    const reservations = await getReservations(new Date(), new Date(Date.now() + oneWeek));
    let responseBody = `Reservations:\n`
    for (const r of reservations) {
      responseBody += `${r.id} ${r.user}: ${r.type} on ${new Date(r.date).toDateString()}\n`;
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
    const known_types = await getTypes('known');
    const args = parseArgs(message);
    let newReservation = {
      date: new Date(args[0]),
      user: message.sender.username,
      type: args[1]
    }
    if (!known_types.includes(newReservation.type)) {
      await bot.chat.send(message.conversationId, {
        body: 'This is not a reservation type I recognize. Was it a typo?',
      });
    }
    if (newReservation.date.getTime() < new Date().getTime()) {
      await bot.chat.send(message.conversationId, {
        body: 'This reservation is in the past. Was that a typo?',
      });
    }
    console.log(newReservation);
    const conflictingReservations = await conn.query(
      'SELECT * FROM reservations WHERE date = ? AND type = ?;', 
      [newReservation.date.toISODate(), newReservation.type]);
    if (conflictingReservations.length > 0) {
      const c = conflictingReservations[0];
      console.log(`Existing reservation ${JSON.stringify(c)} conflicts with new reservation ${JSON.stringify(newReservation)}`);
      bot.chat.send(message.conversationId, {
        body: `This slot is already reserved:
        ${c.user}: ${c.type} on ${c.date}.
        Delete this reservation first if you wish to replace it.`,
      });
      return;
    }
    await conn.query('INSERT INTO reservations (type, date, user) VALUES (?, ?, ?);', 
      [newReservation.type, newReservation.date.toISODate(), newReservation.user]);
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
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to make reservations for other users`,
      });
      return;
    }
    const args = parseArgs(message);
    const known_types = await getTypes('known');
    let newReservation = {
      date: new Date(args[0]),
      user: args[1],
      type: args[2]
    }
    if (!known_types.includes(newReservation.type)) {
      await bot.chat.send(message.conversationId, {
        body: 'This is not a reservation type I recognize. I will make the reservation, please delete it if it was made in error',
      });
    }
    const conflictingReservations = await conn.query(
      'SELECT * FROM reservations WHERE date = ? AND type = ?;', 
      [newReservation.date.toISODate(), newReservation.type]);
    if (conflictingReservations.length > 0) {
      const c = conflictingReservations[0];
      console.log(`Existing reservation ${JSON.stringify(c)} conflicts with new reservation ${JSON.stringify(newReservation)}`);
      bot.chat.send(message.conversationId, {
        body: `This slot is already reserved:
        ${c.user}: ${c.type} on ${new Date(c.date).toISODate()}.
        Delete this reservation first if you wish to replace it.`,
      });
      return;
    }
    await conn.query('INSERT INTO reservations (type, date, user) VALUES (?, ?, ?);', 
      [newReservation.type, newReservation.date.toISODate(), newReservation.user]);
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
    const args = parseArgs(message);
    const date = new Date(args[0]);
    const user = message.sender.username;
    const type = args[1];
    let deletedCount = 0;
    const conflictingReservations = await conn.query(
      'SELECT * FROM reservations WHERE type = ? and date = ?;',
      [type, date.toISODate()]
    );
    for (const r of conflictingReservations) {
      if (r.user === user || await isAdmin(user)) {
        deletedCount += 1;
        conn.query('DELETE FROM reservations WHERE id = ?;', [r.id]);
        continue;
      } else {
        await bot.chat.send(message.conversationId, {
          body: `You do not have permissions to delete reservation:
          ${r.user}: ${r.type} on ${r.date}.
          Please contact an admin to delete it.`,
        });
      }
    }
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
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to grant admin status`,
      });
      return;
    }
    const args = parseArgs(message);
    const toAdd = args[0];
    await conn.query('INSERT INTO admins (keybase_name) VALUES (?);', [toAdd]);
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

async function addKnownType(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to add known event types`,
      });
      return;
    }
    const args = parseArgs(message);
    const toAdd = args[0];
    await conn.query('INSERT INTO known_types (name) VALUES (?);', [toAdd]);
    await bot.chat.send(message.conversationId, {
      body: `Made ${toAdd} a known event type`,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to add known event type, see logs for details.`
    })
  }
}

async function addExpectedType(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to add expected event types`,
      });
      return;
    }
    const args = parseArgs(message);
    const toAdd = args[0];
    const messageIfNone = args[1];
    await conn.query('INSERT INTO expected_types (name, message_if_none) VALUES (?, ?);', [toAdd, messageIfNone]);
    await bot.chat.send(message.conversationId, {
      body: `Made ${toAdd} an expected event type`,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to add expected event type, see logs for details.`
    })
  }
}

async function removeAdmin(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to revoke admin status`,
      });
      return;
    }
    const args = parseArgs(message);
    const toRemove = args[0];
    await conn.query('DELETE FROM admins WHERE keybase_name = ?;', [toRemove]);
    await bot.chat.send(message.conversationId, {
      body: `${toRemove} is no longer an admin`,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to remove admin privileges, see logs for details.`
    })
  }
}

async function deleteById(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to delete reservations by id`,
      });
      return;
    }
    const args = parseArgs(message);
    const toRemove = args[0];
    await conn.query('DELETE FROM reservations WHERE id = ?;', [toRemove]);
    await bot.chat.send(message.conversationId, {
      body: `Reservation ${toRemove} deleted`,
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to delete reservation, see logs for details.`
    })
  }
}

async function makeCron(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to schedule announcements`,
      });
      return;
    }
    const args = parseArgs(message);
    console.log('Scheduling announcement: ', args);
    const announcement = {
      cron: args[0],
      text: args[1],
      include_schedule: args[2] === 't',
      request_volunteers: args[3] === 't'
    };
    await conn.query(
      `INSERT INTO announcements (cron, text, include_schedule, request_volunteers)
      VALUES (?, ?, ?, ?);`, [announcement.cron, announcement.text, 
        announcement.include_schedule, announcement.request_volunteers]);
    cron.schedule(announcement.cron, scheduleAnnouncement(announcement));
    await bot.chat.send(message.conversationId, {
      body: `Scheduled announcement`
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to schedule announcement, see logs for details.`
    });
  }
}

async function listCrons(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to list announcements`,
      });
      return;
    }
    const announcements = await conn.query('SELECT * FROM announcements;');
    res = `Announcements:\n`;
    for (const a of announcements) {
      res += `id: ${a.id}, cron: ${a.cron}, include_schedule: ${a.include_schedule}, request_volunteers: ${a.request_volunteers}
      text:
      ${a.text}\n`;
    }
    await bot.chat.send(message.conversationId, {
      body: res
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to list announcements, see logs for details.`
    });
  }
}

async function deleteCron(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to delete announcements`,
      });
      return;
    }
    const args = parseArgs(message);
    const toDelete = args[0];
    await conn.query('DELETE FROM announcements WHERE id = ?', [toDelete]);
    await bot.chat.send(message.conversationId, {
      body: `Announcement deleted`
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to delete announcement, see logs for details.`
    });
  }
}

async function listTypes(type, message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to list known event types`,
      });
      return;
    }
    const types = await getTypes(type);
    res = `Types:\n`;
    for (const t of types) {
      if (type === 'expected') {
        res += t.name + `\n`;
      } else {
        res += t + `\n`;
      }
    }
    await bot.chat.send(message.conversationId, {
      body: res
    });
  } catch (err) {
    console.log(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to list types, see logs for details.`
    });
  }
}

async function deleteAll(message) {
  try {
    const user = message.sender.username;
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to delete all scheduled reservations`,
      });
      return;
    }
    const numRecords = await conn.query('COUNT(*) FROM reservations;');
    await conn.query('TRUNCATE TABLE reservations;')
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
  try {
    if (!await isAdmin(user)) {
      await bot.chat.send(message.conversationId, {
        body: `You do not have permissions to kill the bot`,
      });
      return;
    }
    await conn.end();
    await bot.chat.send(message.conversationId, {
      body: `Shutting down`,
    });
    process.exit();
  } catch (err) {
    console.error(err);
    await bot.chat.send(message.conversationId, {
      body: `Failed to exit, see logs for details`,
    });
  }
}

async function listAdmins(conversationId) {
  try {
    let responseBody = `Admins:\n`
    const admins = await conn.query('SELECT keybase_name FROM admins;');
    for (const r of admins) {
      responseBody += `${r.keybase_name}\n`;
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
!reservation-bot make: <date> <type> -- make a reservation
!reservation-bot delete: <date> <type> -- delete a reservation
!reservation-bot list-admins -- list admin usernames, contact them if you need an admin
!reservation-bot admin-help -- display admin commands
This bot is a work in progress. Contact aeou1324 for support.`,
  });
}

async function displayAdminHelp(message) {
  const user = message.sender.username;
  if (!await isAdmin(user)) {
    await bot.chat.send(message.conversationId, {
      body: `You do not have permissions to display admin help`,
    });
    return;
  }
  await bot.chat.send(message.conversationId, {
    body: 
`WARNING: These commands run without asking for confirmation, be careful!
Admin usage:
!reservation-bot make-for-other: <date>; <type>; <username> -- make a reservation for someone else
!reservation-bot delete-all -- delete all reservations
!reservation-bot reload -- reload config file
!reservation-bot kill -- shut down the bot
!reservation-bot make-admin: <username> -- make a user an admin
!reservation-bot remove-admin: <username> -- revoke admin privileges
!reservation-bot schedule-announcement: <cron>; <announcement>; <display schedule>; <request volunteers> -- schedule a new recurring announcement
!reservation-bot list-announcements
!reservation-bot delete-announcement: <id> -- delete recurring announcement by id
!reservation-bot add-known: <type>
!reservation-bot list-known
!reservation-bot add-expected: <type>; <message if none>
!reservation-bot list-expected
!reservation-bot delete-by-id: <id> -- delete a reservation by id`
  })
}

async function onMessage(message) {
  if (message.content.type !== 'text') {
    return;
  }
  if (message.content.text.body.split(' ')[0] !== config.commandPrefix) {
    return;
  }
  // TODO: Let admins add/delete announcements
  switch (message.content.text.body.split(' ')[1]) {
    case 'list':
      await displaySchedule(message.conversationId);
      break;
    case 'make:':
      await makeReservation(message);
      break;
    case 'make-for-other:':
      await makeReservationForOther(message);
      break;
    case 'delete:':
      await deleteReservation(message);
      break;
    case 'make-admin:':
      await makeAdmin(message);
      break;
    case 'remove-admin:':
      await removeAdmin(message);
      break;
    case 'list-admins':
      await listAdmins(message.conversationId);
      break;
    case 'help':
      await displayHelp(message.conversationId);
      break
    case 'admin-help':
      await displayAdminHelp(message);
      break;
    case 'delete-all':
      await deleteAll(message);
      break;
    case 'kill':
      await killBot(message);
      break;
    case 'reload':
      await bot.deinit();
      bot = new Bot();
      await initialize();
      break;
    case 'schedule-announcement:':
      await makeCron(message);
      break;
    case 'list-announcements':
      await listCrons(message);
      break;
    case 'delete-announcement:':
      await deleteCron(message);
      break;
    case 'add-known:':
      await addKnownType(message);
      break;
    case 'list-known':
      await listTypes('known', message);
      break;
    case 'add-expected:':
      await addExpectedType(message);
      break;
    case 'list-expected':
      await listTypes('expected', message);
      break;
    case 'delete-by-id:':
      await deleteById(message);
      break;
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