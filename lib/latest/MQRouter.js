'use strict';

const debug = require('debug')('itavy:MQRouter');
const EventEmitter = require('events');
const {
  MS_FACTOR,
  NS_FACTOR,
  IError,
} = require('./Helpers');

/**
 * Class MQRouter
 */
class MQRouter {
  /**
   * @param {Object} connector mq connector
   * @param {Object} mqStructure mq structure message builder
   * @param {Object} serializer mq structure serializer
   * @param {String} name router identifier
   * @param {MQRequestsRoutingTable} requestsRoutingTable routing table for requests
   * @param {MQQueuesRoutingTable} queuesRoutingTable routing table for requests
   * @param {String} [queue=''] own queue on which the router will listen
   * @param {String} [topic=''] own topic on which the router will listen
   * @param {String} [exchange=''] exchange to bind the topic
   * @param {Function} [errorCollector] function to be called when unknown messages are received
   * @param {Function} [defaultHandler] function which resolves to a promise to be called
   * when it receives specific messages
   * @param {Number} [defaultTTL=5] default ttl in seconds for messages or requests sent
   */
  constructor({
    connector,
    mqStructure,
    name,
    serializer,
    requestsRoutingTable,
    queuesRoutingTable,
    queue,
    topic,
    exchange,
    errorCollector = null,
    defaultHandler = null,
    defaultTTL = 5,
  }) {
    this.connector = connector;
    this.mqStructure = mqStructure;

    this.serializer = serializer;
    this.mqrEvents = Reflect.construct(EventEmitter, []);
    this.sourceIdentifier = `${name}.MQRouter`;

    this.requestsRoutingTable = requestsRoutingTable;
    this.requestsRoutingTable.setMessagesTimeoutListener({
      emitter: this.mqrEvents,
    });

    this.queuesRoutingTable = queuesRoutingTable;

    this.mqRequestIds = [];
    this.defaultTTL = defaultTTL * MS_FACTOR;

    this.defaultHandler = defaultHandler;

    this.identification = {
      startTime: process.hrtime(),
      listen:    {
        queue,
        topic,
        exchange,
      },
      subscribed:  false,
      subscribing: false,
      name,
    };

    this.returnDestination = {
      queue: null,
      exchange,
    };

    this.mqrEvents.on('error', (...args) => {
      if (errorCollector instanceof Function) {
        errorCollector.apply(errorCollector, args);
      }
    });

    this.mqrEvents.on('defaultMessageConsumer', this.defaultMessageConsumer);
  }

  /**
   * Send message over mq
   * @param {Buffer} message message to be sent
   * @param {Object} destination where to send the message
   * @param {Object} options options to send mq message
   * @returns {Promise} resolves when the message is accepted by the broker
   */
  async sendMessage({
    message,
    destination,
    options = {},
  }) {
    try {
      return this.sendMQMsg({
        message,
        destination,
        options,
        isRequest: false,
      });
    } catch (cause) {
      debug(`error sending message - ${cause.message}`);
      throw Reflect.construct(IError, [{
        name:   'MQ_ROUTER_SEND_MESSAGE_ERROR',
        source: `${this.sourceIdentifier}.sendMessage`,
        cause,
      }]);
    }
  }

  /**
   * Send request over mq
   * @param {Buffer} message message to be sent
   * @param {Object} destination where to send the message
   * @param {Object} options options to send mq message
   * @returns {Promise} resolves when the message is received
   * @public
   */
  async sendRequest({
    message,
    destination,
    options = {},
  }) {
    try {
      await this.checkIfIsSelfSubscribedForResponses();
      return this.sendMQMsg({
        message,
        destination,
        options,
        isRequest: true,
      });
    } catch (cause) {
      debug(`error sending request - ${cause.message}`);
      throw Reflect.construct(IError, [{
        name:   'MQ_ROUTER_SEND_REQUEST_ERROR',
        source: `${this.sourceIdentifier}.sendRequest`,
        cause,
      }]);
    }
  }

  /**
   * Send request over mq
   * @param {Buffer} message message to be sent
   * @param {Object} destination where to send the message
   * @param {Object} options options to send mq message
   * @param {Boolean} [isRequest=false] if tor this message is expected a response or not
   * @returns {Promise} resolves when the message is received
   * @private
   */
  async sendMQMsg({
    message,
    destination,
    options = {},
    isRequest = false,
  }) {
    await this.validateDestination({ destination });
    const { message: serializedMessage, id } = await this.buildRequest({
      message,
      destination,
    });
    const lOptions = {
      ttl: options.ttl || this.defaultTTL,
    };
    let response = true;
    if (isRequest) {
      response = this.requestsRoutingTable.register({
        options: lOptions,
        id,
      });
    }
    try {
      await this.connector.sendMessage(Object.assign({}, destination, {
        message: serializedMessage,
        options: lOptions,
      }));
    } catch (error) {
      if (response === true) {
        throw error;
      }
      this.requestsRoutingTable.unregister({
        id,
        error,
      });
    }
    return response;
  }

  /**
   * Subscribe to queue
   * @param {Promise} handler Promise to be called when it is received a message
   * @param {String} [queue=''] queue where to subscribe or '' for autogenerated queue
   * @param {String} [topic=''] topic to bind the queue or '' for none
   * @param {String} [exchange=''] exchange to be used for queue and topic or '' for default
   * @param {Object} [options={}] subscribe options
   * @returns {Promise} resolves on success subscribe
   * @public
   */
  async subscribe({
    handler,
    queue = '',
    topic = '',
    exchange = '',
    options = {},
  }) {
    let index = null;
    try {
      ({ index } = this.queuesRoutingTable.register({
        handler,
        queue,
        exchange,
        topic,
      }));
      const { queue: registeredQueue, consumerTag } = await this.connector.subscribe({
        consumer: this.consumeMessages,
        queue,
        topic,
        exchange,
        options,
      });
      this.queuesRoutingTable.update({
        queue: registeredQueue,
        index,
        consumerTag,
      });
      return {
        queue: registeredQueue,
        topic,
        exchange,
      };
    } catch (cause) {
      debug(`error subscribing - ${cause.message}`);
      this.queuesRoutingTable.unregister({ index });
      throw Reflect.construct(IError, {
        name:   'MQ_ROUTER_SUBSCRIBE',
        source: `${this.sourceIdentifier}.subscribe`,
        cause,
      });
    }
  }

  /**
   * internal handler for router
   * @param {MQMessage} message mq messages received
   * @param {String} message.replyId message id for which to reply
   * @param {String} queue queue on which the message was received
   * @param {String} topic topic on which the message was received
   * @param {String} exchange exchange on which the message was received
   * @returns {Promise} resolves on success
   * @private
   */
  async ownHandler({
    message,
    queue,
    topic,
    exchange,
  }) {
    if (message.replyId === '') {
      return this.defaultMessageConsumer({
        message: message.message,
        queue,
        topic,
        exchange,
      });
    }
    return this.requestsRoutingTable.callById({
      id:      message.replyId,
      message: {
        message: message.message,
        queue,
        topic,
        exchange,
      },
    });
  }

  /**
   * Wait for self subscribing
   * @returns {Promise} resolves on success subscribing
   * @private
   */
  async waitForSelfSubscription() {
    return new Promise((resolve, reject) => {
      this.mqrEvents.once('selfSubscribed', ({ error }) => {
        if (error) {
          return reject(error);
        }
        return resolve(error);
      });
    });
  }

  /**
   * Check if router has its own queue or it will make first subscription
   * @returns {Promise} resolves when is subscribed
   * @private
   */
  async checkIfIsSelfSubscribedForResponses() {
    if (this.identification.subscribed) {
      return true;
    }
    if (this.identification.subscribing) {
      return this.waitForSelfSubscription();
    }
    this.identification.subscribing = false;
    try {
      const { topic, queue } = await this.subscribe({
        handler:  this.ownHandler,
        queue:    this.identification.queue,
        topic:    this.identification.topic,
        exchange: this.identification.exchange,
      });
      if (topic === '') {
        this.returnDestination.queue = queue;
      } else {
        this.returnDestination.queue = topic;
      }
      this.identification.subscribing = false;
      this.mqrEvents.emit('selfSubscribed', { error: null });
      return true;
    } catch (cause) {
      this.identification.subscribing = false;
      debug(`Error self subscribing: ${cause.message}`);
      const error = Reflect.construct(IError, [{
        name:   'MQ_ROUTER_SELF_SUBSCRIBE',
        source: `${this.sourceIdentifier}.checkIfIsSelfSubscribedForResponses`,
        cause,
      }]);
      this.mqrEvents.emit('selfSubscribed', { error });
      throw error;
    }
  }

  /**
   * Route received message
   * @param {MQMessage} message received mq message
   * @param {String} message.id original message id
   * @param {String} consumerTag consumer tag for receiver
   * @param {Promise} nack negative ack for this message
   * @param {String} queue queue on which the message was received
   * @param {String} topic topic on which the message was received
   * @param {String} exchange exchange on which the message was received
   * @returns {Promise} resolves on success
   */
  async routeMessage({
    message,
    consumerTag,
    nack,
    queue,
    topic,
    exchange,
  }) {
    try {
      const { handler } = await this.queuesRoutingTable.getHandlerByConsumerTag({ consumerTag });
      const { message: responseMessage } = await handler.apply(handler, {
        message,
        queue,
        topic,
        exchange,
        nack,
        consumerTag,
      });
      return this.respondToRequest({
        message:     responseMessage,
        replyId:     message.id,
        destination: message.replyOn,
      });
    } catch (cause) {
      debug(`Error routing message - ${cause.message}`);
      const error = Reflect.construct(IError, {
        name:   'MQ_ROUTER_ROUTING_ERROR',
        source: `${this.sourceIdentifier}.routeMessage`,
        cause,
      });
      this.mqrEvents.emit('error', {
        error,
        message,
        queue,
        topic,
        exchange,
        consumerTag,
      });
      throw error;
    }
  }

  /**
   * internal consumer
   * @param {Buffer} message mq message,
   * needs to be unserialized before sending to original consumer
   * @param {String} queue queue
   * @param {String} topic topic
   * @param {String} exchange exchange
   * @param {Promise} nack it will resolve on negative ack message
   * @param {String} consumerTag consumer tag for the queue on which message arrived
   * @returns {Promise} consume received message
   * @private
   */
  async consumeMessages({
    message,
    queue,
    topic,
    exchange,
    consumerTag,
    nack,
  }) {
    try {
      const unserializedMessage = await this.serializer.unserialize(message);
      return this.routeMessage({
        message: unserializedMessage,
        nack,
        queue,
        topic,
        exchange,
        consumerTag,
      });
    } catch (cause) {
      debug(`Error consuming message - ${cause.message}`);
      const error = Reflect.construct(IError, {
        name:   'MQ_ROUTER_CONSUME_ERROR',
        source: `${this.sourceIdentifier}.consumeMessages`,
        cause,
      });
      this.mqrEvents.emit('error', {
        error,
        message,
        queue,
        topic,
        exchange,
        consumerTag,
      });
      throw error;
    }
  }

  /**
   * Send response over mq
   * @param {Buffer|null} message response message to be sent
   * @param {String} replyId message id for which respond
   * @param {Object} destination where to send response
   * @returns {Promise} resolves if succed to send message
   * @private
   */
  async respondToRequest({ message, replyId, destination }) {
    if (message === null) {
      return true;
    }
    return this.sendMQMsg({
      isRequest: false,
      message,
      destination,
      replyId,
    });
  }

  /**
   * Default message consumer for direct messages
   * @param {MQMessage} message mq messages received
   * @param {String} message.id original message id
   * @param {String} queue queue on which the message was received
   * @param {String} topic topic on which the message was received
   * @param {String} exchange exchange on which the message was received
   * @returns {Promise} resolves when it finishes
   * @private
   */
  async defaultMessageConsumer({
    message,
    queue,
    topic,
    exchange,
  }) {
    if (this.defaultHandler) {
      const { message: responseMessage } =
        await this.defaultHandler.apply(this.defaultHandler, {
          message: message.message,
          queue,
          topic,
          exchange,
        });
      // if consumer fails to send expected response it is a programming error
      // and it should crash program so it can be early corrected
      await this.respondToRequest({
        message:     responseMessage,
        replyId:     message.id,
        destination: message.replyOn,
      });
      return true;
    }
    const error = Reflect.construct(IError, {
      name:   'MQ_ROUTER_OWN_HANDLER',
      source: `${this.sourceIdentifier}.ownHandler`,
    });
    this.mqrEvents.emit('error', {
      error,
      message,
      queue,
      topic,
      exchange,
    });
    throw error;
  }

  /**
   * Create a message to be sent over MQ
   * @param {Buffer} message message to be sent
   * @param {String} [replyId=''] id of the request message
   * @param {String} [to=''] to who the message is addressed
   * @returns {Promise} resolves with serialized message and the id of th message
   * @private
   */
  async buildRequest({ message, replyId = '', to = '' }) {
    if (!(message instanceof Buffer)) {
      debug('message is not a buffer');
      throw Reflect.construct(IError, {
        name:   'MQ_ROUTER_BUILD_REQUEST_NO_BUFFER',
        source: `${this.sourceIdentifier}.buildRequest`,
      });
    }
    const m = this.mqStructure({
      id:      this.getMessageId(),
      replyTo: replyId,
      replyOn: this.returnDestination,
      from:    this.identification.name,
      to,
      message,
    });

    const serializedMessage = await this.serializer.serialize(m);
    return {
      message: serializedMessage,
      id:      m.id,
    };
  }

  /**
   * Genereate unique message id for this router
   * @returns {String} unique message id
   * @private
   */
  getMessageId() {
    const diff = process.hrtime(this.identification.startTime);
    return `${this.identification.name}.${(diff[0] * NS_FACTOR) + diff[1]}`;
  }

  /**
   * Validate message destination
   * @param {Object} destination where to send the message
   * @returns {Promise} resolves on success
   * @private
   */
  async validateDestination({ destination } = {}) {
    const { queue } = destination;
    if (queue && (queue.length !== 0)) {
      return true;
    }
    throw Reflect.construct(IError({
      name:   'MQ_ROUTER_VALIDATE_DESTINATION',
      source: `${this.sourceIdentifier}.validateDestination`,
    }));
  }
}

module.exports = {
  MQRouter,
};
