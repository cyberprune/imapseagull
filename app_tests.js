
var async = require("async");
var step = require("step");
var extend = require("xtend");
var mongojs = require("mongojs");
var events = require('events');
var path = require('path');
var fs = require("fs");
var bcrypt = require('bcrypt-nodejs');
var AppStorage = require('imapseagull-storage-mongo');

var IMAPServer = require('./lib/server');

var connection = process.env.IMAPSEAGULL_CONNECTION || 'localhost:27017/localhost?auto_reconnect',
    messages = 'emails_test',
    users = 'users_test',
    db = mongojs(connection, [messages, users]);

var MAIL_FIELDS = [
    'text',
    'headers',
    'subject',
    'messageId',
    'priority',
    'from',
    'to',
    'date',
    'attached_files',
    'flags',
    'internaldate',
    'uid'
];

var app_tests = {
    port: 143,
    name: 'localhost',
    testuser_email: 'testuser@localhost',
    testuser_pass: 'testpass',
    testuser: null,

    db_messages: db[messages],
    db_users: db[users],

    uidnext: null,
    running: false
};

app_tests.imap_opts = {
    imapHandler: require('imap-handler'),
    debug: true,
    plugins: ['ID', 'STARTTLS', 'AUTH-PLAIN', 'SPECIAL-USE', 'NAMESPACE', 'IDLE', 'SASL-IR', 'ENABLE', 'LITERALPLUS', 'UNSELECT', 'CONDSTORE'],
    id: {
        name: app_tests.name,
        version: '1'
    },
    credentials: {
        key: fs.readFileSync(path.join(__dirname, './tests/server.key')),
        cert: fs.readFileSync(path.join(__dirname, './tests/server.crt'))
    },
    secureConnection: false,
    folders: {
        'INBOX': {
            'special-use': '\\Inbox',
            type: 'personal'
        },
        '': {
            folders: {
                'Drafts': {
                    'special-use': '\\Drafts',
                    type: 'personal'
                },
                'Sent': {
                    'special-use': '\\Sent',
                    type: 'personal'
                },
                'Junk': {
                    'special-use': '\\Junk',
                    type: 'personal'
                },
                'Trash': {
                    'special-use': '\\Trash',
                    type: 'personal'
                }
            }
        }
    }
};
app_tests.storage_opts = {
    name: app_tests.name,
    debug: true,
    attachments_path: path.join(__dirname, './attachments'),
    connection: connection,
    messages: messages,
    users: users
};

app_tests.createSetUp = function(imap_opts) {
    imap_opts = extend(app_tests.imap_opts, typeof imap_opts != 'undefined' ? imap_opts : {});
    return function(done) {
        app_tests.uidnext = 1;
        if (!app_tests.running) {
            console.log('[STARTED: setUp]');

            step(
                function createAttachmentsPath() {
                    fs.mkdir(app_tests.storage_opts.attachments_path, this);
                },
                function initializeStorage(err) {
                    if (err && err.code != 'EEXIST') throw err;
                    new AppStorage(app_tests.storage_opts).init(this);
                },
                function clearDb(err, storage) {
                    if (err) throw err;
                    app_tests.storage = storage;
                    step(
                        function clearMessages() {
                            app_tests.storage.msgs_remove(null, null, null, this);
                        },
                        function clearUsers(err) {
                            if (err) throw err;
                            app_tests.db_users.remove({}, this);
                        },
                        function done(err) {
                            console.log('[DB: cleared]');
                            this(err);
                        }.bind(this)
                    );
                },
                function createUser(err) {
                    if (err) throw err;
                    bcrypt.genSalt(10, function(err, salt) {
                        if (err) throw err;
                        bcrypt.hash(app_tests.testuser_pass, salt, function() {}, function(err, hash) {
                            if (err) throw new Error(err);

                            app_tests.db_users.insert({ // add test user
                                email: app_tests.testuser_email,
                                password: hash
                            }, function(err, user) {
                                app_tests.testuser = user;
                                console.log('[DB: testuser added]');

                                this(err);
                            }.bind(this));
                        }.bind(this));
                    }.bind(this));
                },
                function startServer(err) {
                    if (err) throw err;
                    imap_opts.storage = app_tests.storage;
                    app_tests.imapServer = IMAPServer(imap_opts);

                    app_tests.imapServer.on('close', function() {
                        console.log('IMAP server closed');
                    });

                    app_tests.imapServer.listen(app_tests.port, function() {
                        app_tests.running = true;

                        console.log('[FINISHED: setUp]');
                        done();
                    });
                }
            );
        } else {
            console.log('[FINISHED: setUp // already run]');
            done();
        }
    }
};

function prepareMessage(message) {
    message.user = mongojs.ObjectId(''+ app_tests.testuser._id);
    message.folder = message.folder || '\\Inbox';
    message.flags = message.flags || [];

    message.uid = message.uid || app_tests.uidnext;
    app_tests.uidnext = message.uid + 1;

    message.internaldate = message.internaldate || new Date();
    return message;
}

app_tests.addMessages = function(mailbox_name, messages, done) {
    console.log('[STARTED: addMessages]');
    async.each(messages, function(message, callback) {
        console.log('[DB: new message]');
        if (typeof message === "object") {
            app_tests.storage.parse_raw_msg(function(mail) {
                MAIL_FIELDS.forEach(function(fld) { // only allowed fields
                    if (message[fld]) {
                        mail[fld] = message[fld];
                    }
                });
                app_tests.db_messages.insert(prepareMessage(mail), callback);
            }).end(message.raw);
        } else {
            app_tests.storage.parse_raw_msg(function(mail) {
                app_tests.db_messages.insert(prepareMessage(mail), callback);
            }).end(message);
        }
    }, function(err) {
        if (err) throw err;
        console.log('[FINISHED: addMessages]');
        done();
    });
};


app_tests.tearDown = function(done) {
    console.log('[STARTED: tearDown]');
    if (app_tests.storage) {
        app_tests.storage.msgs_remove(null, null, null, function () { // DB cleared
            app_tests.imapServer.close(function() {
                app_tests.running = false;
                try {
                    rmDir(app_tests.storage_opts.attachments_path);
                } catch(e) {
                    console.log(e);
                }
                console.log('[FINISHED: tearDown]');
                done();
            });
        }.bind(this));
    } else {
        console.log('[FINISHED: tearDown // no storage]');
        done();
    }
};


// Remove directory recursively
// https://gist.github.com/liangzan/807712
function rmDir(dirPath) {
    var files;
    try { files = fs.readdirSync(dirPath); }
    catch(e) { return; }
    if (files && files.length > 0) {
        for (var i = 0; i < files.length; i++) {
            var filePath = dirPath + '/' + files[i];
            if (fs.statSync(filePath).isFile())
                fs.unlinkSync(filePath);
            else
                rmDir(filePath);
        }
    }
    fs.rmdirSync(dirPath);
}

module.exports = app_tests;
