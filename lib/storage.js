// this file is adapted from mikeal/level-sleep/index.js

var mutex = require('level-mutex')
var sleep = require('sleep-ref')
var through = require('through')
var path = require('path')
var extend = require('extend')
var bops = require('bops')
var jsonBuffStream = require('json-multibuffer-stream')
var debug = require('debug')('dat.storage')

var docUtils = require(path.join(__dirname, 'document'))

function noop() {}

module.exports = Database

function Database (db, meta, cb) {
  if (!(this instanceof Database)) return new Database(db, meta, cb)
  var self = this
  
  this.db = db
  this.meta = meta
  this.mutex = mutex(this.db)
  this.sep = '\xff'
  this.keys = {
    seq:  's',
    data: 'd',
    rev:  'r'
  }
  
  if (!this.meta.json) return cb(new Error('parent was not ready'))
  if (!this.meta.json.columns) this.meta.json.columns = []
  
  self.getSeq(function(err, seq) {
    if (err) {
      self.seq = 0
      return cb()
    }
    self.seq = seq
    cb()
  })
}

Database.prototype._key = function(sublevel, key) {
  return docUtils.key(this.sep, sublevel, key)
}

Database.prototype.getSeq = function(cb) {
  var opts = { 
    start: this._key(this.keys.seq, ''),
    end: this._key(this.keys.seq, this.sep)
  }
  this.mutex.peekLast(opts, function (e, key, val) {
    if (e) return cb(e)
    return cb(false, docUtils.decodeSeq(val)._seq)
  })
}

Database.prototype.get = function (key, opts, cb) {
  var self = this
  
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  
  opts.valueEncoding = 'binary'
  
  var revKey = ''
  if (opts.rev) {
    var revParts = opts.rev.split('-')
    revKey = docUtils.pack(+revParts[0]) + '-' + revParts[1]
  }
  var rowKey = self._key(this.keys.data, key + this.sep + revKey)
  
  extend(opts, {
    start: rowKey,
    end: rowKey + this.sep + this.sep
  })

  this.mutex.peekLast(opts, function (e, k, v) {
    if (e) return cb(e)
    var row = docUtils.decodeRow(k, v, self.meta)
    if (row._deleted) return cb(new Error('row has been deleted'))
    if (row.error && row.type === 'columnMismatch') {
      // schema may have been updated, try reading JSON and trying again
      self.meta.read(function(err, json) {
        self.meta.json = json
        var row = docUtils.decodeRow(k, v, self.meta)
        if (row.error && row.type === 'columnMismatch') return cb(row)
        return cb(null, row)
      })
    } else {
      cb(null, row)
    }
  })
}

// .put(obj, buff, opts, cb)
// .put(buff, opts, cb)
// .put(obj, buff, cb)
// .put(obj, opts, cb)
// .put(obj, cb)
// .put(buff, cb)

Database.prototype.put = function (rawDoc, buffer, opts, cb) {
  var self = this
  var doc = rawDoc
  var updated
  
  if (bops.is(rawDoc)) {
    cb = opts
    opts = buffer
    buffer = rawDoc
    doc = {}
    rawDoc = undefined
  }
  
  if (!bops.is(buffer)) {
    cb = opts
    opts = buffer
    buffer = undefined
  } else {
    doc = {}
  }
  
  if (!cb) {
    cb = opts
    opts = {}
  }
  
  var columns = Object.keys(doc)
  if (opts.columns) columns = columns.concat(opts.columns)
  var newColumns = this.meta.getNewColumns(columns)
  if (newColumns.error) return cb(newColumns)
  if (newColumns.length === 0) return store()
  
  self.meta.addColumns(newColumns, function(err) {
    if (err) return cb(err)
    store()
  })  
  
  function store() {
    if (!opts.overwrite) updated = docUtils.updateRevision(doc, buffer, self.meta.json.columns)
    else updated = doc
    
    var seq = self.seq = self.seq + 1
  
    var keys = docUtils.rowKeys(self.keys, self.sep, updated._id, updated._rev, seq, updated._deleted)
  
    opts.valueEncoding = 'binary'
    
    if (!buffer) buffer = jsonBuffStream.encode(updated, self.meta.json.columns)
    var seqVal = [seq, updated._id, updated._rev]
    if (updated._deleted) seqVal.push(true) // 4th spot in seqVal array is a deleted boolean
    
    self.mutex.put(keys.seq, JSON.stringify(seqVal), noop)
    self.mutex.put(keys.row, buffer, opts, afterUpdate)
    
    function afterUpdate(err) {
      if (err) return cb(err)
      cb(null, updated)
    }
  }
}

// TODO should revs be necessary for deletes?
Database.prototype.delete = function (key, opts, cb) {
  var self = this
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  
  self.get(key, function(err, row) {
    if (err) return cb(err)
    row._deleted = true
    self.put(row, cb)
  })
}

Database.prototype.createReadStream = function(opts) {
  var stream = through()
  var self = this
  if (!opts) opts = {}
  if (!opts.start) {
    proceed("")
  } else {
    var startKey = self._key(self.keys.data, opts.start)
    self.mutex.peekFirst({start: startKey}, function(err, key, value) {
      var key = docUtils.decodeKey(key)
      proceed(key._id)
    })
  }
  
  return stream
  
  function proceed(fromKey) {
    getNext(fromKey, function(err, row) {
      if (err) return stream.queue(null)
      stream.queue(row)
      proceed(row._id)
    })
  }
  
  function getNext(key, cb) {
    var peekOpts = {
      'start': self._key(self.keys.data, key),
      'end': self._key(self.keys.data, key) + self.sep + self.sep,
      valueEncoding: 'binary'
    }
    
    debug('latestStream', peekOpts, key)
    self.mutex.peekLast(peekOpts, function (e, key, value) {
      if (e) return cb(new Error('not found.'))
      if (opts.end) {
        var endKey = self._key(self.keys.data, opts.end)
        debug('latest end?', key, endKey)
        if (key > endKey) {
          return cb(true)
        }
      }
      var doc = docUtils.decodeRow(key, value, self.meta)
      cb(null, doc)
    })
  }
}

// gets all versions of a id
Database.prototype.createVersionStream = function (id, opts) {
  if (!opts) opts = {}
  var rs = this.createReadStream({
    'start': id,
    'end': id + this.sep + this.sep
  })
  return rs
}

Database.prototype.createChangesStream = function (opts) {
  if (!opts) opts = {}
  opts.since = +opts.since || 0
  opts.limit = +opts.limit || -1
  var pending = []
  var self = this
  var seqStream = through()
  
  seqStream.on('end', function() {
    // clean up liveStream
    sequences.destroy()
  })
  
  var since = 0
  if (opts.since) since = opts.since + 1 // everything after, not including
  var startKey = this._key(this.keys.seq, docUtils.pack(since))
  var endKey = this._key(this.keys.seq, this.sep)
  var rangeOpts = { 
    start: startKey,
    end: endKey,
    limit: opts.limit
  }
  
  var sequences
  if (opts.live) sequences = this.db.liveStream(rangeOpts)
  else sequences = this.db.createReadStream(rangeOpts)
  
  sequences.on('data', function (seqRow) {
    var change = docUtils.decodeSeq(seqRow.value)
    var entry = { 
      id: change._id,
      seq: change._seq,
      rev: change._rev
    }
    if (change._deleted) entry.deleted = true
    if (opts.include_data) {
      // even if it was deleted we do a get to ensure correct ordering by relying on the mutex
      var getOpts = { rev: entry.rev }
      self.get(entry.id, getOpts, function (e, value) {
        if (!entry.deleted) entry.data = value
        seqStream.queue(entry)
      })
    } else {
      seqStream.queue(entry)
    }
  })
  sequences.on('end', function () {
    // hack: get something from the mutex to ensure we're after any data gets
    self.mutex.get('foo', function () {
      seqStream.queue(null)
    })
  })
  return seqStream
}

Database.prototype.createPullStream = function (url, opts) {
  var self = this
    
  if (!opts) opts = {}
  if (typeof opts.style === 'undefined') opts.style = "newline"
  if (typeof opts.include_data === 'undefined') opts.include_data = true

  var stream = through(write)
  
  this.getSeq(function(err, seq) {
    if (err) seq = 0
    opts.since = seq
    stream.client = sleep.client(url, opts)
    stream.client.pipe(stream)
  })
  
  return stream
  
  function write(entry) {
    this.queue(entry.data)
  }
}

Database.prototype.compact = function (cb) {
  var self = this

  var rangeOpts = { 
    start: this._key(this.keys.data, this.sep),
    end: this._key(this.keys.data, ''),
    reverse: true
  }

  var sequences = self.db.createReadStream(rangeOpts)
  var id = null
  var seqs = []
  var deletes = []
  sequences.on('data', function (row) {
    var _id = row.value._id
    var seq = row.value._seq
    var deleted = row.value._deleted
    if (id !== _id) {
      id = _id
    } else {
      deletes.push(self._key(self.keys.seq, docUtils.pack(seq)))
      deletes.push(row.key)
    }
  })
  sequences.on('end', function () {
    deletes.forEach(function (entry) {
      self.mutex.del(entry, noop)
    })
    if (deletes.length === 0) return cb(null)
    else self.mutex.afterWrite(cb)
  })
}
