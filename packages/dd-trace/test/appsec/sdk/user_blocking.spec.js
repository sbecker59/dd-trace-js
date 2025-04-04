'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const axios = require('axios')
const path = require('path')
const waf = require('../../../src/appsec/waf')
const { USER_ID } = require('../../../src/appsec/addresses')
const blocking = require('../../../src/appsec/blocking')

const resultActions = {
  block_request: {
    status_code: '401',
    type: 'auto',
    grpc_status_code: '10'
  }
}

describe('user_blocking', () => {
  describe('Internal API', () => {
    const req = { protocol: 'https' }
    const res = { headersSent: false }
    const tracer = {}

    let rootSpan, getRootSpan, block, legacyStorage, log, userBlocking

    before(() => {
      const runStub = sinon.stub(waf, 'run')
      runStub.withArgs({ persistent: { [USER_ID]: 'user' } }).returns(resultActions)
      runStub.withArgs({ persistent: { [USER_ID]: 'gooduser' } }).returns({})
    })

    beforeEach(() => {
      rootSpan = {
        context: () => {
          return { _tags: {} }
        },
        setTag: sinon.stub()
      }
      getRootSpan = sinon.stub().returns(rootSpan)

      block = sinon.stub().returns(true)

      legacyStorage = {
        getStore: sinon.stub().returns({ req, res })
      }

      log = {
        warn: sinon.stub()
      }

      userBlocking = proxyquire('../../../src/appsec/sdk/user_blocking', {
        './utils': { getRootSpan },
        '../blocking': { block },
        '../../../../datadog-core': { storage: () => legacyStorage },
        '../../log': log
      })
    })

    describe('checkUserAndSetUser', () => {
      it('should return false and log warn when passed no user', () => {
        const ret = userBlocking.checkUserAndSetUser()
        expect(ret).to.be.false
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to isUserBlocked')
      })

      it('should return false and log warn when passed invalid user', () => {
        const ret = userBlocking.checkUserAndSetUser({})
        expect(ret).to.be.false
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to isUserBlocked')
      })

      it('should set user when not already set', () => {
        const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
        expect(ret).to.be.true
        expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
        expect(rootSpan.setTag).to.have.been.calledWithExactly('usr.id', 'user')
        expect(rootSpan.setTag).to.have.been.calledWithExactly('_dd.appsec.user.collection_mode', 'sdk')
      })

      it('should not override user when already set', () => {
        rootSpan.context = () => {
          return { _tags: { 'usr.id': 'mockUser' } }
        }

        const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
        expect(ret).to.be.true
        expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
        expect(rootSpan.setTag).to.not.have.been.called
      })

      it('should log warn when rootSpan is not available', () => {
        getRootSpan.returns(undefined)

        const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
        expect(ret).to.be.true
        expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Root span not available in isUserBlocked')
        expect(rootSpan.setTag).to.not.have.been.called
      })

      it('should return false when received no results', () => {
        const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'gooduser' })
        expect(ret).to.be.false
        expect(rootSpan.setTag).to.have.been.calledWithExactly('usr.id', 'gooduser')
        expect(rootSpan.setTag).to.have.been.calledWithExactly('_dd.appsec.user.collection_mode', 'sdk')
      })
    })

    describe('blockRequest', () => {
      it('should get req and res from local storage when they are not passed', () => {
        const ret = userBlocking.blockRequest(tracer)
        expect(ret).to.be.true
        expect(legacyStorage.getStore).to.have.been.calledOnce
        expect(block).to.be.calledOnceWithExactly(req, res, rootSpan)
      })

      it('should log warning when req or res is not available', () => {
        legacyStorage.getStore.returns(undefined)

        const ret = userBlocking.blockRequest(tracer)
        expect(ret).to.be.false
        expect(legacyStorage.getStore).to.have.been.calledOnce
        expect(log.warn)
          .to.have.been.calledOnceWithExactly('[ASM] Requests or response object not available in blockRequest')
        expect(block).to.not.have.been.called
      })

      it('should return false and log warn when rootSpan is not available', () => {
        getRootSpan.returns(undefined)

        const ret = userBlocking.blockRequest(tracer, {}, {})
        expect(ret).to.be.false
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Root span not available in blockRequest')
        expect(block).to.not.have.been.called
      })

      it('should call block with proper arguments', () => {
        const req = {}
        const res = {}
        const ret = userBlocking.blockRequest(tracer, req, res)
        expect(ret).to.be.true
        expect(log.warn).to.not.have.been.called
        expect(block).to.have.been.calledOnceWithExactly(req, res, rootSpan)
      })
    })
  })

  describe('Integration with the tracer', () => {
    const config = new Config({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, './user_blocking_rules.json')
      }
    })

    let http
    let controller
    let appListener
    let port

    function listener (req, res) {
      if (controller) {
        controller(req, res)
      }
    }

    before(async () => {
      await agent.load('http')
      http = require('http')
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => {
          port = appListener.address().port
          done()
        })

      appsec.enable(config)
    })

    after(() => {
      appsec.disable()

      appListener.close()
      return agent.close({ ritmReset: false })
    })

    describe('isUserBlocked', () => {
      it('should set the user if user is not defined', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
          expect(ret).to.be.false
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser3')
          expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not set the user if user is already defined', (done) => {
        controller = (req, res) => {
          tracer.setUser({ id: 'testUser' })

          const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
          expect(ret).to.be.false
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser')
          expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should return true if user is in the blocklist', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
          expect(ret).to.be.true
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
          expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should return true action if userID was matched before with trackUserLoginSuccessEvent()', (done) => {
        controller = (req, res) => {
          tracer.appsec.trackUserLoginSuccessEvent({ id: 'blockedUser' })
          const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
          expect(ret).to.be.true
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })

    describe('blockRequest', () => {
      beforeEach(() => {
        // reset to default, other tests may have changed it with RC
        blocking.setDefaultBlockingActionParameters(undefined)
      })

      afterEach(() => {
        // reset to default
        blocking.setDefaultBlockingActionParameters(undefined)
      })

      it('should set the proper tags', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.blockRequest(req, res)
          expect(ret).to.be.true
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
          expect(traces[0][0].meta).to.have.property('http.status_code', '403')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should set the proper tags even when not passed req and res', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.blockRequest()
          expect(ret).to.be.true
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
          expect(traces[0][0].meta).to.have.property('http.status_code', '403')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not set the proper tags when response has already been sent', (done) => {
        controller = (req, res) => {
          res.end()
          const ret = tracer.appsec.blockRequest()
          expect(ret).to.be.false
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.not.have.property('appsec.blocked', 'true')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          expect(traces[0][0].metrics).to.have.property('_dd.appsec.block.failed', 1)
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should block using redirect data if it is configured', (done) => {
        blocking.setDefaultBlockingActionParameters([
          {
            id: 'notblock',
            parameters: {
              location: '/notfound',
              status_code: 404
            }
          },
          {
            id: 'block',
            parameters: {
              location: '/redirected',
              status_code: 302
            }
          }
        ])
        controller = (req, res) => {
          const ret = tracer.appsec.blockRequest(req, res)
          expect(ret).to.be.true
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
          expect(traces[0][0].meta).to.have.property('http.status_code', '302')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`, { maxRedirects: 0 })
      })
    })
  })
})
