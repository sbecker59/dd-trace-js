'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../../packages/dd-trace/src/log')

const producerStartCh = channel('apm:confluent-kafka-javascript:produce:start')
const producerCommitCh = channel('apm:confluent-kafka-javascript:produce:commit')
const producerFinishCh = channel('apm:confluent-kafka-javascript:produce:finish')
const producerErrorCh = channel('apm:confluent-kafka-javascript:produce:error')

const consumerStartCh = channel('apm:confluent-kafka-javascript:consume:start')
const consumerCommitCh = channel('apm:confluent-kafka-javascript:consume:commit')
const consumerFinishCh = channel('apm:confluent-kafka-javascript:consume:finish')
const consumerErrorCh = channel('apm:confluent-kafka-javascript:consume:error')


addHook({ name: '@confluentinc/kafka-javascript', file: 'lib/kafkajs/_kafka.js', versions: [ '>=0.1.15-devel' ] }, exports => {

  shimmer.wrap(exports.Kafka.prototype, 'producer', fn => function () {
    const producer = fn.apply(this, arguments)
    const send = producer.send
    const bootstrapServers = undefined

    producer.send = function () {
      const innerAsyncResource = new AsyncResource('bound-anonymous-fn')

      return innerAsyncResource.runInAsyncScope(() => {
        if (!producerStartCh.hasSubscribers) {
          return send.apply(this, arguments)
        }

        try {
          const { topic, messages = [] } = arguments[0]
          for (const message of messages) {
            if (typeof message === 'object') {
              message.headers = message.headers || {}
            }
          }

          log.debug(() => topic, messages, bootstrapServers)

          producerStartCh.publish({ topic, messages, bootstrapServers })

          const result = send.apply(this, arguments)

          result.then(
            innerAsyncResource.bind(res => {
              producerFinishCh.publish(undefined)
              producerCommitCh.publish(res)
            }),
            innerAsyncResource.bind(err => {
              if (err) {
                producerErrorCh.publish(err)
              }
              producerFinishCh.publish(undefined)
            })
          )

          return result
        } catch (e) {
          producerErrorCh.publish(e)
          producerFinishCh.publish(undefined)
          throw e
        }
      })
    }
    return producer
    
  })

  shimmer.wrap(exports.Kafka.prototype, 'consumer', fn => function () {
    if (!consumerStartCh.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const consumer = fn.apply(this, arguments)

    consumer.on(consumer.events.COMMIT_OFFSETS, commitsFromEvent)

    const run = consumer.run

    const groupId = arguments[0].groupId
    consumer.run = function ({ eachMessage, ...runArgs }) {
      if (typeof eachMessage !== 'function') return run({ eachMessage, ...runArgs })

      return run({
        eachMessage: function (...eachMessageArgs) {
          const topic = "topic"
          const partition = "partition"
          const message = "message"
          const groupId = "groupId"
      
          consumerStartCh.publish({ topic, partition, message, groupId })
          consumerFinishCh.publish(undefined)
        }
      })
    }

    return consumer
  })
  

  return exports
})
