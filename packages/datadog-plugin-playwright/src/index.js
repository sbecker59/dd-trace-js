'use strict'

const { storage } = require('../../datadog-core')
const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')

const {
  TEST_STATUS,
  finishAllTraceSpans,
  getTestSuitePath,
  getTestSuiteCommonTags,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SOURCE_FILE,
  TEST_PARAMETERS,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TELEMETRY_TEST_SESSION,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_BROWSER_NAME,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED
} = require('../../dd-trace/src/plugins/util/test')
const { RESOURCE_NAME } = require('../../../ext/tags')
const { COMPONENT } = require('../../dd-trace/src/constants')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED
} = require('../../dd-trace/src/ci-visibility/telemetry')
const { appClosing: appClosingTelemetry } = require('../../dd-trace/src/telemetry')

class PlaywrightPlugin extends CiPlugin {
  static get id () {
    return 'playwright'
  }

  constructor (...args) {
    super(...args)

    this._testSuites = new Map()
    this.numFailedTests = 0
    this.numFailedSuites = 0

    this.addSub('ci:playwright:session:finish', ({
      status,
      isEarlyFlakeDetectionEnabled,
      isTestManagementTestsEnabled,
      onDone
    }) => {
      this.testModuleSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.setTag(TEST_STATUS, status)

      if (isEarlyFlakeDetectionEnabled) {
        this.testSessionSpan.setTag(TEST_EARLY_FLAKE_ENABLED, 'true')
      }

      if (this.numFailedSuites > 0) {
        let errorMessage = `Test suites failed: ${this.numFailedSuites}.`
        if (this.numFailedTests > 0) {
          errorMessage += ` Tests failed: ${this.numFailedTests}`
        }
        const error = new Error(errorMessage)
        this.testModuleSpan.setTag('error', error)
        this.testSessionSpan.setTag('error', error)
      }

      if (isTestManagementTestsEnabled) {
        this.testSessionSpan.setTag(TEST_MANAGEMENT_ENABLED, 'true')
      }

      this.testModuleSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
      this.testSessionSpan.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
      finishAllTraceSpans(this.testSessionSpan)
      this.telemetry.count(TELEMETRY_TEST_SESSION, {
        provider: this.ciProviderName,
        autoInjected: !!process.env.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER
      })
      appClosingTelemetry()
      this.tracer._exporter.flush(onDone)
      this.numFailedTests = 0
    })

    this.addSub('ci:playwright:test-suite:start', (testSuiteAbsolutePath) => {
      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)

      const testSuiteMetadata = getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        'playwright'
      )
      if (testSourceFile) {
        testSuiteMetadata[TEST_SOURCE_FILE] = testSourceFile
        testSuiteMetadata[TEST_SOURCE_START] = 1
      }
      const codeOwners = this.getCodeOwners(testSuiteMetadata)
      if (codeOwners) {
        testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
      }

      const testSuiteSpan = this.tracer.startSpan('playwright.test_suite', {
        childOf: this.testModuleSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')
      this.enter(testSuiteSpan, store)

      this._testSuites.set(testSuite, testSuiteSpan)
    })

    this.addSub('ci:playwright:test-suite:finish', ({ status, error }) => {
      const store = storage('legacy').getStore()
      const span = store && store.span
      if (!span) return
      if (error) {
        span.setTag('error', error)
        span.setTag(TEST_STATUS, 'fail')
      } else {
        span.setTag(TEST_STATUS, status)
      }

      if (status === 'fail' || error) {
        this.numFailedSuites++
      }

      span.finish()
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
    })

    this.addSub('ci:playwright:test:start', ({
      testName,
      testSuiteAbsolutePath,
      testSourceLine,
      browserName,
      isDisabled
    }) => {
      const store = storage('legacy').getStore()
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, this.rootDir)
      const testSourceFile = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
      const span = this.startTestSpan(testName, testSuite, testSourceFile, testSourceLine, browserName)

      if (isDisabled) {
        span.setTag(TEST_MANAGEMENT_IS_DISABLED, 'true')
      }

      this.enter(span, store)
    })
    this.addSub('ci:playwright:test:finish', ({
      testStatus,
      steps,
      error,
      extraTags,
      isNew,
      isEfdRetry,
      isRetry,
      isAttemptToFix,
      isQuarantined,
      isAttemptToFixRetry,
      hasFailedAllRetries,
      hasPassedAttemptToFixRetries
    }) => {
      const store = storage('legacy').getStore()
      const span = store && store.span
      if (!span) return

      span.setTag(TEST_STATUS, testStatus)

      if (error) {
        span.setTag('error', error)
      }
      if (extraTags) {
        span.addTags(extraTags)
      }
      if (isNew) {
        span.setTag(TEST_IS_NEW, 'true')
        if (isEfdRetry) {
          span.setTag(TEST_IS_RETRY, 'true')
          span.setTag(TEST_RETRY_REASON, 'efd')
        }
      }
      if (isRetry) {
        span.setTag(TEST_IS_RETRY, 'true')
      }
      if (hasFailedAllRetries) {
        span.setTag(TEST_HAS_FAILED_ALL_RETRIES, 'true')
      }
      if (isAttemptToFix) {
        span.setTag(TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, 'true')
      }
      if (isAttemptToFixRetry) {
        span.setTag(TEST_IS_RETRY, 'true')
        span.setTag(TEST_RETRY_REASON, 'attempt_to_fix')
      }
      if (hasPassedAttemptToFixRetries) {
        span.setTag(TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, 'true')
      }
      if (isQuarantined) {
        span.setTag(TEST_MANAGEMENT_IS_QUARANTINED, 'true')
      }

      steps.forEach(step => {
        const stepStartTime = step.startTime.getTime()
        const stepSpan = this.tracer.startSpan('playwright.step', {
          childOf: span,
          startTime: stepStartTime,
          tags: {
            [COMPONENT]: this.constructor.id,
            'playwright.step': step.title,
            [RESOURCE_NAME]: step.title
          }
        })
        if (step.error) {
          stepSpan.setTag('error', step.error)
        }
        let stepDuration = step.duration
        if (stepDuration <= 0 || isNaN(stepDuration)) {
          stepDuration = 0
        }
        stepSpan.finish(stepStartTime + stepDuration)
      })

      if (testStatus === 'fail') {
        this.numFailedTests++
      }

      this.telemetry.ciVisEvent(
        TELEMETRY_EVENT_FINISHED,
        'test',
        {
          hasCodeOwners: !!span.context()._tags[TEST_CODE_OWNERS],
          isNew,
          browserDriver: 'playwright'
        }
      )
      span.finish()

      finishAllTraceSpans(span)
    })
  }

  startTestSpan (testName, testSuite, testSourceFile, testSourceLine, browserName) {
    const testSuiteSpan = this._testSuites.get(testSuite)

    const extraTags = {
      [TEST_SOURCE_START]: testSourceLine
    }
    if (testSourceFile) {
      extraTags[TEST_SOURCE_FILE] = testSourceFile || testSuite
    }
    if (browserName) {
      // Added as parameter too because it should affect the test fingerprint
      extraTags[TEST_PARAMETERS] = JSON.stringify({ arguments: { browser: browserName }, metadata: {} })
      extraTags[TEST_BROWSER_NAME] = browserName
    }

    return super.startTestSpan(testName, testSuite, testSuiteSpan, extraTags)
  }
}

module.exports = PlaywrightPlugin
