
import { createServer, IncomingMessage } from 'node:http'

import jsontypedef from 'jsontypedef'
import inject from 'light-my-request'
import getRawBody from 'raw-body'
import Ajv from 'ajv/dist/jtd.js'

const kRoutes = Symbol('kRoutes')
const kDispatcher = Symbol('kDispatcher')
const kServer = Symbol('kServer')
const kRoute = Symbol('kRoute')

export default function Pitico (endpoints) {
  const ajv = new Ajv()
  const routes = new Map()
  const noop = () => {}
  const server = {
    [kRoutes]: routes,
    [kDispatcher] (req, res) {
      const route = routes.get(req.url)
      const handle = route?.handle

      if (handle) {
        handleRequest(req, route)
          .then(req => handle(req, res))
          .then(json => sendResponse(res, route, json))
          .catch(err => handleError(res, err))
      } else {
        handleNotFound(res)
      }
    },
    [kRoute] (routeModule, exportedPath) {
      const {
        path: routeModulePath,
        handle,
        parse: parsingSchema,
        serialize: serializingSchema
      } = typeof routeModule === 'function'
        ? routeModule(this, jsontypedef)
        : routeModule
      const parse = parsingSchema &&
        ajv.compileParser(parsingSchema)
      const serialize = serializingSchema &&
        ajv.compileSerializer(serializingSchema)
      const path = exportedPath ?? routeModulePath
      this[kRoutes].set(path, { parse, serialize, handle })
    },
    addHook: noop,
    inject (options) {
      return new Promise((resolve, reject) => {
        inject(this[kDispatcher], options, (err, res) => {
          if (err) {
            return reject(err)
          }
          resolve(res)
        })
      })
    },
    decorate (key, value) {
      this[key] = value
    },
    decorateRequest (key, value) {
      IncomingMessage.prototype[key] = value
    },
    async register (plugin, options) {
      try {
        await plugin(this, options, (err) => {
          if (err) {
            fatal(err)
          }
        })
      } catch (err) {
        fatal(err)
      }
    },
    async listen (options) {
      return new Promise((resolve, reject) => {
        this[kServer].listen(options, (err) => {
          if (err) {
            return reject(err)
          }
          resolve()
        })
      })
    }
  }

  if (Array.isArray(endpoints)) {
    for (const endpoint of endpoints) {
      server[kRoute](endpoint.default ?? endpoint, endpoint.path)
    }
  } else {
    for (const [path, endpoint] of Object.entries(endpoints)) {
      server[kRoute](path, endpoint)
    }
  }

  server[kServer] = createServer(server[kDispatcher])

  return server
}

IncomingMessage.prototype.body = null

function handleRequest (req, { parse }) {
  return new Promise((resolve, reject) => {
    getRawBody(req, {
      length: req.headers['content-length'],
      limit: '1mb',
      encoding: 'utf8'
    }, (err, data) => {
      if (err) {
        return reject(err)
      }
      if (data) {
        req.body = (parse ?? JSON.parse)(data)
      }
      resolve(req)
    })
  })
}

function sendResponse (res, route, json) {
  if (!json) {
    res.setHeader('Content-Type', 'plain/text')
    res.end('')
    return
  }
  const serialized = route.serialize
    ? route.serialize(json)
    : JSON.stringify(json)
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(serialized)
  })
  res.end(serialized)
}

function handleNotFound (res) {
  res.statusCode = 404
  res.end('')
}

function handleError (res, err) {
  const errString = err.toString()
  res.statusCode = 500
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(errString),
  })
  res.end(errString)
}

function fatal (error) {
  console.error(error)
  process.exit(1)
}
