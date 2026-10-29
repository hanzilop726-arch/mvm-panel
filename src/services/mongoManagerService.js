const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { client, ensureConnected } = require('../lib/db');
const config = require('../lib/config');
const logger = require('../lib/logger');

const BACKUP_DIR = path.join(config.root, 'storage/backups/mongodb');

function ensureBackupDir() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (_) {}
}

function parseId(idStr) {
  if (typeof idStr === 'object' && idStr !== null) return idStr;
  const s = String(idStr).trim();
  if (ObjectId.isValid(s) && (s.length === 24 || s.length === 12)) {
    try { return new ObjectId(s); } catch (_) {}
  }
  if (!isNaN(s) && s !== '' && !s.includes('.')) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

function parseExtendedJson(strOrObj) {
  if (typeof strOrObj !== 'string') return strOrObj;
  return JSON.parse(strOrObj, (key, value) => {
    if (value && typeof value === 'object') {
      if (value.$oid) return new ObjectId(value.$oid);
      if (value.$date) return new Date(value.$date);
      if (value.$numberLong) return Number(value.$numberLong);
      if (value.$numberInt) return Number(value.$numberInt);
    }
    return value;
  });
}

function maskMongoUri(uri) {
  if (!uri) return 'mongodb://localhost:27017';
  try {
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:******@');
  } catch (_) {
    return uri;
  }
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  if (!seconds) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ') || `${s}s`;
}

class MongoManagerService {
  constructor() {
    ensureBackupDir();
  }

  async getStatus() {
    await ensureConnected();
    const admin = client.db('admin');
    const [buildInfo, serverStatus] = await Promise.all([
      admin.command({ buildInfo: 1 }).catch(() => ({ version: 'unknown' })),
      admin.command({ serverStatus: 1 }).catch(() => ({})),
    ]);

    let parsedHost = '127.0.0.1';
    let parsedPort = 27017;
    try {
      const match = config.mongoUri.match(/@?([^/:]+):(\d+)/);
      if (match) {
        parsedHost = match[1];
        parsedPort = parseInt(match[2], 10);
      }
    } catch (_) {}

    return {
      connected: !!client.topology?.isConnected(),
      version: buildInfo.version || 'unknown',
      gitVersion: buildInfo.gitVersion,
      sysInfo: buildInfo.sysInfo,
      host: serverStatus.host || parsedHost,
      port: parsedPort,
      pid: serverStatus.pid,
      uptime: serverStatus.uptime || 0,
      uptimeFormatted: formatUptime(serverStatus.uptime || 0),
      storageEngine: serverStatus.storageEngine?.name || 'wiredTiger',
      uri: maskMongoUri(config.mongoUri),
      activeDatabase: 'vpanel',
    };
  }

  async getServerStats() {
    await ensureConnected();
    const admin = client.db('admin');
    const serverStatus = await admin.command({ serverStatus: 1 });

    const memRes = serverStatus.mem?.resident || 0;
    const memVirt = serverStatus.mem?.virtual || 0;
    const netIn = serverStatus.network?.bytesIn || 0;
    const netOut = serverStatus.network?.bytesOut || 0;

    return {
      uptime: serverStatus.uptime || 0,
      uptimeFormatted: formatUptime(serverStatus.uptime || 0),
      connections: {
        current: serverStatus.connections?.current || 0,
        available: serverStatus.connections?.available || 0,
        totalCreated: serverStatus.connections?.totalCreated || 0,
      },
      mem: {
        resident: memRes,
        virtual: memVirt,
      },
      memory: {
        residentMb: memRes,
        virtualMb: memVirt,
        bits: serverStatus.mem?.bits || 64,
      },
      network: {
        bytesIn: netIn,
        bytesOut: netOut,
        bytesInFormatted: formatBytes(netIn),
        bytesOutFormatted: formatBytes(netOut),
        numRequests: serverStatus.network?.numRequests || 0,
      },
      opcounters: serverStatus.opcounters || { insert: 0, query: 0, update: 0, delete: 0, command: 0 },
      storageEngine: serverStatus.storageEngine?.name || 'wiredTiger',
    };
  }

  async listDatabases() {
    await ensureConnected();
    const admin = client.db('admin');
    const result = await admin.command({ listDatabases: 1 });
    const databases = [];

    for (const db of result.databases || []) {
      let collCount = 0;
      let objCount = 0;
      let dataSize = db.sizeOnDisk || 0;
      try {
        const stats = await client.db(db.name).stats().catch(() => null);
        if (stats) {
          collCount = stats.collections || 0;
          objCount = stats.objects || 0;
          dataSize = stats.dataSize || db.sizeOnDisk || 0;
        }
      } catch (_) {}

      databases.push({
        name: db.name,
        sizeOnDisk: db.sizeOnDisk || 0,
        sizeFormatted: formatBytes(db.sizeOnDisk || 0),
        dataSize,
        dataSizeFormatted: formatBytes(dataSize),
        empty: db.empty || false,
        collections: collCount,
        objects: objCount,
        isSystem: ['admin', 'config', 'local'].includes(db.name),
      });
    }

    return {
      databases,
      totalSize: result.totalSize || 0,
      totalSizeFormatted: formatBytes(result.totalSize || 0),
      totalCount: databases.length,
    };
  }

  async createDatabase(dbName, initialCollection = 'init') {
    await ensureConnected();
    const cleanDbName = String(dbName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanColl = String(initialCollection || 'init').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanDbName) throw new Error('Invalid database name');

    const db = client.db(cleanDbName);
    await db.createCollection(cleanColl);
    await db.collection(cleanColl).insertOne({
      _init: true,
      created_at: new Date().toISOString(),
      system_note: 'Database initialized by MVM Panel Studio',
    });
    return { ok: true, database: cleanDbName, collection: cleanColl };
  }

  async dropDatabase(dbName) {
    await ensureConnected();
    const cleanDbName = String(dbName || '').trim();
    if (!cleanDbName) throw new Error('Database name required');
    if (['admin', 'config', 'local'].includes(cleanDbName)) {
      throw new Error(`Cannot drop protected system database '${cleanDbName}'`);
    }
    const result = await client.db(cleanDbName).dropDatabase();
    return { ok: !!result, database: cleanDbName };
  }

  async getDatabaseStats(dbName) {
    await ensureConnected();
    const target = String(dbName || 'vpanel').trim();
    const stats = await client.db(target).stats();
    return {
      ...stats,
      dataSizeFormatted: formatBytes(stats.dataSize || 0),
      storageSizeFormatted: formatBytes(stats.storageSize || 0),
      indexSizeFormatted: formatBytes(stats.indexSize || 0),
    };
  }

  async listCollections(dbName = 'vpanel') {
    await ensureConnected();
    const db = client.db(dbName);
    const colls = await db.listCollections().toArray();
    const list = [];

    for (const c of colls) {
      if (c.name.startsWith('system.')) continue;
      let count = 0;
      let size = 0;
      let storageSize = 0;
      let avgObjSize = 0;
      let indexCount = 0;

      try {
        count = await db.collection(c.name).countDocuments().catch(() => 0);
        const stats = await db.command({ collStats: c.name }).catch(() => null);
        if (stats) {
          size = stats.size || 0;
          storageSize = stats.storageSize || 0;
          avgObjSize = stats.avgObjSize || 0;
          indexCount = stats.nindexes || 0;
        }
      } catch (_) {}

      list.push({
        name: c.name,
        type: c.type || 'collection',
        count,
        size,
        sizeFormatted: formatBytes(size || storageSize || 0),
        storageSize,
        storageSizeFormatted: formatBytes(storageSize || 0),
        avgObjSize,
        avgObjSizeFormatted: formatBytes(avgObjSize || 0),
        indexesCount: indexCount,
        indexCount,
        options: c.options || {},
      });
    }

    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }

  async createCollection(dbName = 'vpanel', collectionName, options = {}) {
    await ensureConnected();
    const name = String(collectionName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) throw new Error('Invalid collection name');

    const createOpts = {};
    if (options.capped) {
      createOpts.capped = true;
      createOpts.size = parseInt(options.size, 10) || 1048576; // 1MB default
      if (options.max) createOpts.max = parseInt(options.max, 10);
    }

    await client.db(dbName).createCollection(name, createOpts);
    return { ok: true, collection: name };
  }

  async dropCollection(dbName = 'vpanel', collectionName) {
    await ensureConnected();
    const name = String(collectionName || '').trim();
    if (!name) throw new Error('Collection name required');
    const result = await client.db(dbName).collection(name).drop();
    return { ok: result };
  }

  async truncateCollection(dbName = 'vpanel', collectionName) {
    await ensureConnected();
    const name = String(collectionName || '').trim();
    if (!name) throw new Error('Collection name required');
    const result = await client.db(dbName).collection(name).deleteMany({});
    return { ok: true, deletedCount: result.deletedCount };
  }

  async getDocuments(dbName = 'vpanel', collectionName, { filter = {}, sort = { _id: -1 }, page = 1, limit = 20 } = {}) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);

    let parsedFilter = {};
    if (typeof filter === 'string' && filter.trim()) {
      try {
        parsedFilter = parseExtendedJson(filter);
      } catch (e) {
        parsedFilter = { $text: { $search: filter.trim() } };
      }
    } else if (typeof filter === 'object' && filter !== null) {
      parsedFilter = filter;
    }

    if (parsedFilter._id && typeof parsedFilter._id === 'string') {
      const parsedId = parseId(parsedFilter._id);
      parsedFilter._id = { $in: [parsedId, parsedFilter._id, Number(parsedFilter._id) || 0] };
    }

    let parsedSort = { _id: -1 };
    if (typeof sort === 'string' && sort.trim()) {
      try {
        parsedSort = JSON.parse(sort);
      } catch (_) {}
    } else if (typeof sort === 'object' && sort !== null) {
      parsedSort = sort;
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (p - 1) * lim;

    const [documents, total] = await Promise.all([
      coll.find(parsedFilter).sort(parsedSort).skip(skip).limit(lim).toArray(),
      coll.countDocuments(parsedFilter).catch(() => 0),
    ]);

    const columnKeysSet = new Set();
    for (const doc of documents) {
      for (const k of Object.keys(doc)) {
        columnKeysSet.add(k);
      }
    }
    const columns = Array.from(columnKeysSet);
    if (columns.includes('_id')) {
      columns.splice(columns.indexOf('_id'), 1);
      columns.unshift('_id');
    }

    return {
      documents,
      total,
      page: p,
      limit: lim,
      pages: Math.ceil(total / lim) || 1,
      columns,
    };
  }

  async getDocumentById(dbName = 'vpanel', collectionName, docId) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    const parsed = parseId(docId);
    let doc = await coll.findOne({ _id: parsed });
    if (!doc) doc = await coll.findOne({ id: Number(docId) });
    if (!doc && typeof parsed !== 'string') doc = await coll.findOne({ _id: String(docId) });
    return doc;
  }

  async insertDocument(dbName = 'vpanel', collectionName, docData) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    let doc = typeof docData === 'string' ? parseExtendedJson(docData) : docData;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      throw new Error('Document must be a valid JSON object');
    }

    if (doc._id) {
      doc._id = parseId(doc._id);
    }

    const result = await coll.insertOne(doc);
    return { ok: true, insertedId: result.insertedId, doc };
  }

  async updateDocument(dbName = 'vpanel', collectionName, docId, updatedDocData) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    let updateObj = typeof updatedDocData === 'string' ? parseExtendedJson(updatedDocData) : updatedDocData;
    if (typeof updateObj !== 'object' || updateObj === null || Array.isArray(updateObj)) {
      throw new Error('Update payload must be a JSON object');
    }

    const parsed = parseId(docId);
    delete updateObj._id;

    const filter = { $or: [{ _id: parsed }, { _id: String(docId) }, { id: Number(docId) || -9999 }] };

    let res;
    if (Object.keys(updateObj).some(k => k.startsWith('$'))) {
      res = await coll.updateOne(filter, updateObj);
    } else {
      res = await coll.updateOne(filter, { $set: updateObj });
    }

    return { ok: true, modifiedCount: res.modifiedCount, matchedCount: res.matchedCount };
  }

  async deleteDocument(dbName = 'vpanel', collectionName, docId) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    const parsed = parseId(docId);
    const res = await coll.deleteOne({
      $or: [{ _id: parsed }, { _id: String(docId) }, { id: Number(docId) || -9999 }],
    });
    return { ok: true, deletedCount: res.deletedCount };
  }

  async listIndexes(dbName = 'vpanel', collectionName) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    const indexes = await coll.indexes();
    return indexes;
  }

  async createIndex(dbName = 'vpanel', collectionName, keys, options = {}) {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    let parsedKeys = typeof keys === 'string' ? JSON.parse(keys) : keys;
    const name = await coll.createIndex(parsedKeys, options);
    return { ok: true, indexName: name };
  }

  async dropIndex(dbName = 'vpanel', collectionName, indexName) {
    await ensureConnected();
    if (indexName === '_id_') throw new Error('Cannot drop the default _id index');
    const coll = client.db(dbName).collection(collectionName);
    const res = await coll.dropIndex(indexName);
    return { ok: true, result: res };
  }

  async runQuery(dbName = 'vpanel', collectionName, queryType = 'find', payload = {}) {
    await ensureConnected();
    const startTime = process.hrtime.bigint();
    const coll = client.db(dbName).collection(collectionName);

    let result;
    let count = 0;

    switch (queryType) {
      case 'find': {
        const filter = payload.filter ? parseExtendedJson(payload.filter) : {};
        const sort = payload.sort ? parseExtendedJson(payload.sort) : { _id: -1 };
        const limit = Math.min(200, parseInt(payload.limit, 10) || 50);
        result = await coll.find(filter).sort(sort).limit(limit).toArray();
        count = result.length;
        break;
      }
      case 'findOne': {
        const filter = payload.filter ? parseExtendedJson(payload.filter) : {};
        result = await coll.findOne(filter);
        count = result ? 1 : 0;
        break;
      }
      case 'countDocuments': {
        const filter = payload.filter ? parseExtendedJson(payload.filter) : {};
        count = await coll.countDocuments(filter);
        result = { count };
        break;
      }
      case 'aggregate': {
        const pipeline = typeof payload.pipeline === 'string' ? parseExtendedJson(payload.pipeline) : (payload.pipeline || []);
        if (!Array.isArray(pipeline)) throw new Error('Aggregation pipeline must be an array');
        result = await coll.aggregate(pipeline).toArray();
        count = result.length;
        break;
      }
      case 'stats': {
        result = await client.db(dbName).command({ collStats: collectionName });
        count = 1;
        break;
      }
      case 'insertOne': {
        const doc = typeof payload.document === 'string' ? parseExtendedJson(payload.document) : payload.document;
        result = await coll.insertOne(doc);
        count = 1;
        break;
      }
      case 'updateOne': {
        const filter = typeof payload.filter === 'string' ? parseExtendedJson(payload.filter) : payload.filter;
        const update = typeof payload.update === 'string' ? parseExtendedJson(payload.update) : payload.update;
        result = await coll.updateOne(filter, update);
        count = result.modifiedCount;
        break;
      }
      case 'deleteOne': {
        const filter = typeof payload.filter === 'string' ? parseExtendedJson(payload.filter) : payload.filter;
        result = await coll.deleteOne(filter);
        count = result.deletedCount;
        break;
      }
      default:
        throw new Error(`Unsupported query type '${queryType}'`);
    }

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;

    return {
      ok: true,
      queryType,
      durationMs: Number(durationMs.toFixed(2)),
      count,
      result,
    };
  }

  async exportCollection(dbName = 'vpanel', collectionName) {
    await ensureConnected();
    ensureBackupDir();
    const coll = client.db(dbName).collection(collectionName);
    const documents = await coll.find({}).toArray();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${dbName}_${collectionName}_${timestamp}.json`;
    const filePath = path.join(BACKUP_DIR, filename);

    fs.writeFileSync(filePath, JSON.stringify(documents, null, 2), 'utf8');
    const stat = fs.statSync(filePath);

    return {
      ok: true,
      filename,
      filePath,
      sizeBytes: stat.size,
      documentCount: documents.length,
      createdAt: new Date().toISOString(),
    };
  }

  listBackups() {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR);
    const backups = [];

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const fullPath = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(fullPath);
        const parts = f.replace('.json', '').split('_');
        const dbName = parts[0] || 'vpanel';
        const collName = parts[1] || 'collection';

        backups.push({
          filename: f,
          dbName,
          collName,
          db: dbName,
          collection: collName,
          sizeBytes: stat.size,
          sizeFormatted: formatBytes(stat.size),
          createdAt: stat.mtime.toISOString(),
          created_at: stat.mtime.toISOString(),
        });
      } catch (_) {}
    }

    backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return backups;
  }

  async importCollection(dbName = 'vpanel', collectionName, docsArrayOrJsonString, mode = 'append') {
    await ensureConnected();
    const coll = client.db(dbName).collection(collectionName);
    let docs = typeof docsArrayOrJsonString === 'string'
      ? parseExtendedJson(docsArrayOrJsonString)
      : docsArrayOrJsonString;

    if (!Array.isArray(docs)) {
      if (typeof docs === 'object' && docs !== null) docs = [docs];
      else throw new Error('Import data must be a JSON array of documents');
    }

    if (mode === 'replace') {
      await coll.deleteMany({});
    }

    if (docs.length === 0) {
      return { ok: true, importedCount: 0 };
    }

    const preparedDocs = docs.map((d) => {
      const copy = { ...d };
      if (copy._id) copy._id = parseId(copy._id);
      return copy;
    });

    const result = await coll.insertMany(preparedDocs, { ordered: false });
    return {
      ok: true,
      importedCount: result.insertedCount,
      mode,
    };
  }

  deleteBackup(filename) {
    ensureBackupDir();
    const safeName = path.basename(filename);
    const target = path.join(BACKUP_DIR, safeName);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      return { ok: true, filename: safeName };
    }
    throw new Error('Backup file not found');
  }

  getBackupFilePath(filename) {
    ensureBackupDir();
    const safeName = path.basename(filename);
    const target = path.join(BACKUP_DIR, safeName);
    if (fs.existsSync(target)) return target;
    return null;
  }

  async listUsers(dbName = 'admin') {
    await ensureConnected();
    try {
      const res = await client.db(dbName).command({ usersInfo: 1 });
      return res.users || [];
    } catch (e) {
      logger.warn(`[mongoManager] listUsers: ${e.message}`);
      return [];
    }
  }

  async createUser(dbName = 'admin', { username, password, roles = ['readWrite'] }) {
    await ensureConnected();
    const u = String(username || '').trim();
    const p = String(password || '').trim();
    if (!u || !p) throw new Error('Username and password are required');

    const formattedRoles = (Array.isArray(roles) ? roles : [roles]).map((r) => {
      if (typeof r === 'string') return { role: r, db: dbName };
      return r;
    });

    await client.db(dbName).command({
      createUser: u,
      pwd: p,
      roles: formattedRoles,
    });
    return { ok: true, username: u, db: dbName, roles: formattedRoles };
  }

  async dropUser(dbName = 'admin', username) {
    await ensureConnected();
    const u = String(username || '').trim();
    if (!u) throw new Error('Username is required');
    await client.db(dbName).command({ dropUser: u });
    return { ok: true, username: u, db: dbName };
  }
}

module.exports = new MongoManagerService();
