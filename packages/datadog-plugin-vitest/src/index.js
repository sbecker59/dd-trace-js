const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { storage } = require('../../datadog-core')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME
} = require('../../dd-trace/src/plugins/util/test')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION
} = require('../../dd-trace/src/ci-visibility/telemetry')

// Milliseconds that we subtract from the error test duration
// so that they do not overlap with the following test
// This is because there's some loss of resolution.
const MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION = 5

class VitestPlugin extends CiPlugin {
  static get id () {
    return 'vitest'
  }

  constructor (...args) {
    super(...args)

    this.taskToFinishTime = new WeakMap()

    this.addSub('ci:vitest:test:start', ({ testName, testSuiteAbsolutePath, isRetry }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const store = storage.getStore()

      const extraTags = {
        [TEST_SOURCE_FILE]: testSuite
      }
      if (isRetry) {
        extraTags[TEST_IS_RETRY] = 'true'
      }

      const span = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        extraTags
      )

      this.enter(span, store)
    })

    this.addSub('ci:vitest:test:finish-time', ({ status, task }) => {
      const store = storage.getStore()
      const span = store?.span

      // we store the finish time to finish at a later hook
      // this is because the test might fail at a `afterEach` hook
      if (span) {
        span.setTag(TEST_STATUS, status)
        this.taskToFinishTime.set(task, span._getTime())
      }
    })

    this.addSub('ci:vitest:test:pass', ({ task }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'pass')
        span.finish(this.taskToFinishTime.get(task))
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:error', ({ duration, error }) => {
      const store = storage.getStore()
      const span = store?.span

      if (span) {
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
          hasCodeowners: !!span.context()._tags[TEST_CODE_OWNERS]
        })
        span.setTag(TEST_STATUS, 'fail')

        if (error) {
          span.setTag('error', error)
        }
        if (duration) {
          span.finish(span._startTime + duration - MILLISECONDS_TO_SUBTRACT_FROM_FAILED_TEST_DURATION) // milliseconds
        } else {
          span.finish() // retries will not have a duration
        }
        finishAllTraceSpans(span)
      }
    })

    this.addSub('ci:vitest:test:skip', ({ testName, testSuiteAbsolutePath }) => {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSpan = this.startTestSpan(
        testName,
        testSuite,
        this.testSuiteSpan,
        {
          [TEST_SOURCE_FILE]: testSuite,
          [TEST_STATUS]: 'skip'
        }
      )
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', {
        hasCodeowners: !!testSpan.context()._tags[TEST_CODE_OWNERS]
      })
      testSpan.finish()
    })

    this.addSub('ci:vitest:test-suite:start', ({ testSuiteAbsolutePath, frameworkVersion }) => {
      this.frameworkVersion = frameworkVersion
      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': process.env.DD_CIVISIBILITY_TEST_SESSION_ID,
        'x-datadog-parent-id': process.env.DD_CIVISIBILITY_TEST_MODULE_ID
      })

      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const testSuiteMetadata = getTestSuiteCommonTags(
        process.env.DD_CIVISIBILITY_TEST_COMMAND,
        this.frameworkVersion,
        testSuite,
        'vitest'
      )
      testSuiteMetadata[TEST_SESSION_NAME] = process.env.DD_CIVISIBILITY_TEST_SESSION_NAME

      const testSuiteSpan = this.tracer.startSpan('vitest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      const store = storage.getStore()
      this.enter(testSuiteSpan, store)
      this.testSuiteSpan = testSuiteSpan
    })

    this.addSub('ci:vitest:test-suite:finish', ({ status, onFinish }) => {
      const store = storage.getStore()
      const span = store?.span
      if (span) {
        span.setTag(TEST_STATUS, status)
        span.finish()
        finishAllTraceSpans(span)
      }
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
      // TODO: too frequent flush - find for method in worker to decrease frequency
      this.tracer._exporter.flush(onFinish)
    })

    this.addSub('ci:vitest:test-suite:error', ({ error }) => {
      const store = storage.getStore()
      const span = store?.span
      if (span && error) {
        span.setTag('error', error)
        span.setTag(TEST_STATUS, 'fail')
      }
    })

    this.addSub('ci:vitest:session:finish', ({ status, onFinish, error, testCodeCoverageLinesTotal }) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testModuleSpan.setTag(TEST_STATUS, status)
      if (error) {
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }
      if (testCodeCoverageLinesTotal) {
        this.testModuleSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
        this.testSessionSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
      }
      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, { provider: this.ciProviderName })
      this.tracer._exporter.flush(onFinish)
    })
  }
}

module.exports = VitestPlugin
