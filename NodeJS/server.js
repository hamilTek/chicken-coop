var mosca      = require('mosca')
 ,  yaml       = require('read-yaml')
 ,  express    = require('express')
 ,  Primus     = require('primus')
 ,  app        = express()
 ,  moment     = require('moment')
 ,  path       = require('path');

var config = yaml.sync('config.yml');
var socket = null;

// Sends time information every 'beaconInterval' seconds
var timeBeacon = function() {
  var message = {
    topic: 'time/beacon',
    payload: moment().format('MMM DD YYYY|HH:mm:ss|x'),
    qos: 0,
    retain: false
  };

  mqttServer.publish(message);
};
setInterval(timeBeacon, (config.beacon.interval * 1000));

app.set('db', require('./models'));

var mqttServer = mosca.Server(config.mqtt);
app.express = express;
require('./routes')(app);

// Setup static file path
app.use(express.static(__dirname + '/public'));

// Force all requests not to a defined route thru the static index.html file
// this is necessary for html5routes to work properly with angular.
app.use(function(req, res) {
  res.sendfile(path.normalize(__dirname + '/public/index.html'));
});

var server = app.listen(config.web.port, config.web.host, function() {
  console.log('Webserver listening at http://%s:%s', config.web.host, config.web.port);
});

/*******************
 ***  MQTT stuff ***
 *******************/

mqttServer.on('ready', function() {
  console.log('MQTT Broker listening at %s on port %s', config.mqtt.host, config.mqtt.port);
});


mqttServer.on('published', function(packet, client) {
  switch(packet.topic) {
    case 'coop/temperature':
      var Temperature = app.get('db').Temperature;
      Temperature.create({ reading: parseFloat(packet.payload) });
      primus.write({
        update: {
          temp: parseFloat(packet.payload)
        }
      });
      break;
    case 'coop/brightness':
      var Brightness = app.get('db').Brightness;
      Brightness.create({ reading: parseInt(packet.payload) });
      primus.write({
        update: {
          light: parseInt(packet.payload)
        }
      });
      break;
    case 'coop/status':
      var Status = app.get('db').Status;
      var data = packet.payload.toString().split('|');
      Status.upsert({ id: data[0], status: data[1] });
      primus.write({
        update: {
          name: data[0],
          status: data[1],
          updated: parseInt(moment().format('X'))
        }
      });
      break;
  }
});


/*********************
 ***  Socket stuff ***
 *********************/

var primus = new Primus(server, { transformer: 'socket.io' });

primus.on('connection', function (spark) {
  // Hydrate brightness data
  var Brightness = app.get('db').Brightness;
  Brightness.findAll({
    where: {
      createdAt: {
        $gt: moment().subtract(24, 'hours').format('YYYY-MM-DD HH:mm:ss')
      }
    },
    order: [ ['createdAt', 'ASC'] ]
  }).then(function(results) {
    var data = [];
    results.forEach(function(result) {
      data.push({
        createdAt: parseInt(moment(result.dataValues.createdAt).format('x')),
        reading: result.dataValues.reading
      });
    });
    spark.write({ lightReadings: data });
  });

  // Hydrate temperature data
  var Temperature = app.get('db').Temperature;
  Temperature.findAll({
    where: {
      createdAt: {
        $gt: moment().subtract(24, 'hours').format('YYYY-MM-DD HH:mm:ss')
      }
    },
    order: [ ['createdAt', 'ASC'] ]
  }).then(function(results) {
    var data = [];
    results.forEach(function(result) {
      data.push({
        createdAt: parseInt(moment(result.dataValues.createdAt).format('x')),
        reading: result.dataValues.reading
      });
    });
    spark.write({ tempReadings: data });
  });

  // Hydrate status data
  var Status = app.get('db').Status;
  Status.findAll({
    order: [ ['id', 'ASC'] ]
  }).then(function(results) {
    var data = [];
    results.forEach(function(result) {
      data.push({
        name: result.dataValues.id,
        status: result.dataValues.status,
        updated: parseInt(moment(result.dataValues.updatedAt).format('X'))
      });
    });
    spark.write({ statuses: data });
  });

  // Handle remote trigger events (handoff from socket to mqtt)
  spark.on('data', function(data) {
    if (typeof data.remoteTrigger != 'undefined') {
      var message = {
        topic: 'coop/remotetrigger',
        payload: data.remoteTrigger,
        qos: 0,
        retain: false
      };

      mqttServer.publish(message);
    }
  })
});