'use strict';

const expect = require('../../testHelpers').getExpect();
const utils = require('../../../lib/utilities').getUtilities();
const rabbitMqLib = require('../../../lib/Connectors/RabbitMQ');
const fixtures = require('./Fixtures');

it('Should export required info', (done) => {
  expect(Object.keys(rabbitMqLib).length).to.equal(2);
  expect(rabbitMqLib).to.have.property('getConnector');
  expect(rabbitMqLib).to.have.property('RabbitMQ');

  done();
});

it('Should return an instance of MQJSONSerializer', (done) => {
  const testConnector = rabbitMqLib.getConnector({
    moduleName:      fixtures.moduleName,
    connURI:         fixtures.rabbitMQConnUri,
    mqLib:           fixtures.mqLib,
    exchangeName:    fixtures.exchangeName,
    exchangeOptions: fixtures.exchangeOptions,
    publishTTL:      fixtures.publishTTL,
    utils,
  });
  expect(testConnector).to.be.instanceof(rabbitMqLib.RabbitMQ);
  done();
});

it('Should have expected properties', (done) => {
  const testConnector = rabbitMqLib.getConnector({
    moduleName:      fixtures.moduleName,
    connURI:         fixtures.rabbitMQConnUri,
    mqLib:           fixtures.mqLib,
    exchangeName:    fixtures.exchangeName,
    exchangeOptions: fixtures.exchangeOptions,
    publishTTL:      fixtures.publishTTL,
    utils,
  });
  [
    'connect',
    'setupSubscribe',
    'setupChannel',
    'publish',
    'unsubscribe',
    'subscribe',
    'start',
  ].forEach(funcName => expect(testConnector).to.have.property(funcName).that.is.a('function'));
  done();
});
