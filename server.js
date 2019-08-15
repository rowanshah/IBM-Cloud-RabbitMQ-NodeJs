"use strict";
/* jshint node:true */


const express = require("express");
const app = express();
const url = require("url");


const bodyParser = require("body-parser");
app.use(
    bodyParser.urlencoded({
        extended: false
    })
);


const util = require("util");
const assert = require("assert");

// We want to extract the port to publish our app on
let port = process.env.PORT || 8080;

// Then we'll pull in the database client library

const amqp = require("amqplib/callback_api");

function bail(err, conn) {
    console.error(err);
    if (conn)
        conn.close(function() {
            process.exit(1);
        });
}


var cfenv = require("cfenv");

let vcapLocal;
try {
  vcapLocal = require('./vcap-local.json');
  console.log("Loaded local VCAP");
} catch (e) { 
    // console.log(e)
}

const appEnvOpts = vcapLocal ? { vcap: vcapLocal} : {}
const appEnv = cfenv.getAppEnv(appEnvOpts);

let services = appEnv.services;

let rabbitmq_services = services["compose-for-rabbitmq"];

assert(
  !util.isUndefined(rabbitmq_services),
  "Must be bound to compose-for-rabbitmq services"
);

// We now take the first bound RabbitMQ service and extract its credentials object
let credentials = rabbitmq_services[0].credentials;

// Connect using a connection string from the credentials
let connectionString = credentials.uri;

var options = {};

if (credentials.uri.includes("composedb.com")) {
  var uri = url.parse(credentials.uri);
  options = {
    servername: uri.hostname
  };
} else {
 
  var caCert = new Buffer.from(credentials.ca_certificate_base64, "base64");

  options = {
    ca: [caCert] // Trusted certificates
  };
}

// Bind a queue to the exchange to listen for messages
// When we publish a message, it will be sent to this queue, via the exchange
let routingKey = "words";
let exchangeName = "grandtour";
let qName = "sample";

amqp.connect(connectionString, options, function(
    err,
    conn
) {
    if(err) {
        console.log(err);
        process.exit(1);
    }
    conn.createChannel(function(err, ch) {
        ch.assertExchange(exchangeName, "direct", { durable: true });
        ch.assertQueue(qName, { exclusive: false }, function(err, q) {
            console.log(" [*] Waiting for messages in the queue '%s'", q.queue);
            ch.bindQueue(q.queue, exchangeName, routingKey);
        });
    });
    setTimeout(function() {
        conn.close();
    }, 500);
});

// Add a message to the queue
function addMessage(message) {
    return new Promise(function(resolve, reject) {
        // To send a message, we first open a connection
        amqp.connect(connectionString, options, function(
            err,
            conn
        ) {
            if (err !== null) return bail(err, conn);

            // Then we create a channel
            conn.createChannel(function(err, channel) {
                if (err !== null) return bail(err, conn);

                // And we publish the message to an exchange
                channel.assertExchange(
                    exchangeName,
                    "direct", {
                        durable: true
                    },
                    function(err, ok) {
                        if (err !== null) return bail(err, conn);
                        channel.publish(exchangeName, routingKey, new Buffer(message));
                    }
                );
            });

            let msgTxt = message + " : Message sent at " + new Date();
            console.log(" [+] %s", msgTxt);
            setTimeout(function() {
                conn.close();
            }, 500);
            resolve(msgTxt);
        });
    });
}

// Get a message from the queue
function getMessage() {
    return new Promise(function(resolve, reject) {
        // To receive a message, we first open a connection
        amqp.connect(connectionString, options , function(
            err,
            conn
        ) {
            if (err !== null) return bail(err, conn);

            // With the connection open, we then create a channel
            conn.createChannel(function(err, channel) {
                if (err !== null) return bail(err, conn);

                // ...and get a message from the queue, which is bound to the exchange
                channel.get(
                    qName, {},
                    function(err, msgOrFalse) {
                        if (err !== null) return bail(err, conn);

                        let result = "No message received";

                        if (msgOrFalse !== false) {
                            channel.ack(msgOrFalse);
                            result =
                                msgOrFalse.content.toString() +
                                " : Message received at " +
                                new Date();
                            console.log(" [-] %s", result);
                        } else {
                            // There's nothing, write a message saying that
                            result = "No messages in the queue";
                            console.log(" [x] %s", result);
                        }

                        // close the channel
                        channel.close();
                        // and set a timer to close the connection (there's an ack in transit)
                        setTimeout(function() {
                            conn.close();
                        }, 500);
                        resolve(result);
                    }, { noAck: true }
                );
            });
        });
    });
}

// With the database going to be open as some point in the future, we can
// now set up our web server. First up we set it to server static pages
app.use(express.static(__dirname + "/public"));

// The user has clicked submit to add a word and definition to the database
// Send the data to the addWord function and send a response if successful
app.put("/message", function(request, response) {
    addMessage(request.body.message)
        .then(function(resp) {
            response.send(resp);
        })
        .catch(function(err) {
            console.log("error:", err);
            response.status(500).send(err);
        });

});


// Read from the database when the page is loaded or after a word is successfully added
// Use the getWords function to get a list of words and definitions from the database
app.get("/message", function(request, response) {
    getMessage()
        .then(function(words) {
            response.send(words);
        })
        .catch(function(err) {
            console.log(err);
            response.status(500).send(err);
        });
});

// Listen for a connection.
app.listen(port, function() {
    console.log("Server is listening on port " + port);
});


