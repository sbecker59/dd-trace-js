'use strict'

const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')

class ConfluentKafkaJavascriptPlugin extends CompositePlugin {
  static get id () { return 'confluent-kafka-javascript' }
  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = ConfluentKafkaJavascriptPlugin
