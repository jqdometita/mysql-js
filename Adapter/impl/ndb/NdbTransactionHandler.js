/*
 Copyright (c) 2013, Oracle and/or its affiliates. All rights
 reserved.
 
 This program is free software; you can redistribute it and/or
 modify it under the terms of the GNU General Public License
 as published by the Free Software Foundation; version 2 of
 the License.
 
 This program is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 GNU General Public License for more details.
 
 You should have received a copy of the GNU General Public License
 along with this program; if not, write to the Free Software
 Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 02110-1301  USA
 */

"use strict";

var stats = {
	"created"		: 0,
	"run_async" : 0,
	"run_sync"  : 0,
	"execute"   : { "commit": 0, "no_commit" : 0}, 
	"commit"    : 0,
	"rollback"  : 0
};

var adapter         = require(path.join(build_dir, "ndb_adapter.node")).ndb,
    ndbsession      = require("./NdbSession.js"),
    ndboperation    = require("./NdbOperation.js"),
    doc             = require(path.join(spi_doc_dir, "DBTransactionHandler")),
    stats_module    = require(path.join(api_dir,"stats.js")),
    udebug          = unified_debug.getLogger("NdbTransactionHandler.js"),
    QueuedAsyncCall = require("../common/QueuedAsyncCall.js").QueuedAsyncCall,
    AutoIncHandler  = require("./NdbAutoIncrement.js").AutoIncHandler,
    proto           = doc.DBTransactionHandler,
    COMMIT          = adapter.ndbapi.Commit,
    NOCOMMIT        = adapter.ndbapi.NoCommit,
    ROLLBACK        = adapter.ndbapi.Rollback,
    AO_ABORT        = adapter.ndbapi.AbortOnError,
    AO_IGNORE       = adapter.ndbapi.AO_IgnoreError,
    AO_DEFAULT      = adapter.ndbapi.DefaultAbortOption,
    modeNames       = [],
    serial          = 1;

stats_module.register(stats, "spi","ndb","DBTransactionHandler");

modeNames[COMMIT] = 'commit';
modeNames[NOCOMMIT] = 'noCommit';
modeNames[ROLLBACK] = 'rollback';

function DBTransactionHandler(dbsession) {
  this.dbSession          = dbsession;
  this.autocommit         = true;
  this.ndbtx              = null;
  this.sentNdbStartTx     = false;
  this.execCount          = 0;   // number of execute calls 
  this.nTxRecords         = 1;   // 1 for non-scan, 2 for scan
  this.pendingOpsLists    = [];  // [ execCallNumber : dbOperationList, ... ]
  this.executedOperations = [];  // All finished operations 
  this.execAfterOpenQueue = [];  // exec calls waiting on startTransaction()
  this.asyncContext       = dbsession.parentPool.asyncNdbContext;
  this.serial             = serial++;
  this.moniker            = "(" + this.serial + ")";
  this.retries            = 0;
  udebug.log("NEW ", this.moniker);
  stats.created++;
}
DBTransactionHandler.prototype = proto;

/* NdbTransactionHandler internal run():
   Create a QueuedAsyncCall on the Ndb's execQueue.
*/
function run(self, execMode, abortFlag, callback) {
  var qpos;
  var apiCall = new QueuedAsyncCall(self.dbSession.execQueue, callback);
  apiCall.tx = self;
  apiCall.execMode = execMode;
  apiCall.abortFlag = abortFlag;
  apiCall.description = "execute_" + modeNames[execMode];
  apiCall.run = function runExecCall() {
    /* NDB Execute.
       "Sync" execute is an async operation for the JavaScript user,
        but the uv worker thread uses synchronous NDBAPI execute().

        In "Async" execute, the DBConnectionPool listener thread runs callbacks.
        executeAsynch() itself can run either sync (in JS thread) or async
        (in uv thread).  Supply an onSend callback as the 6th argument to make
        it run async.
    */
    var force_send = 1;

    if(this.tx.asyncContext) {
      stats.run_async++;
      this.tx.asyncContext.executeAsynch(this.tx.ndbtx,
                                         this.execMode, this.abortFlag,
                                         force_send, this.callback);
    }
    else {
      stats.run_sync++;
      this.tx.ndbtx.executeAndClose(this.execMode, this.abortFlag, 
                                    force_send, this.callback);
    }
  };

  qpos = apiCall.enqueue();
  udebug.log("run()", self.moniker, "queue position:", qpos);
}

/* runExecAfterOpenQueue()
*/
function runExecAfterOpenQueue(dbTxHandler) {
  var queue = dbTxHandler.execAfterOpenQueue;
  var item = queue.shift();
  if(item) {
    udebug.log("runExecAfterOpenQueue - remaining", queue.length);
    dbTxHandler.execute(item.dbOperationList, item.callback);
  }  
}

/* Error handling after NdbTransaction.execute() 
*/
function attachErrorToTransaction(dbTxHandler, err) {
  if(err) {
    dbTxHandler.success = false;
    dbTxHandler.error = new ndboperation.DBOperationError().fromNdbError(err.ndb_error);
    /* Special handling for duplicate value in unique index: */
    if(err.ndb_error.code === 893) {
      dbTxHandler.error.cause = dbTxHandler.error;
    }
  }
  else {
    dbTxHandler.success = true;
  }
}

/* EXECUTE PATH FOR KEY OPERATIONS
   -------------------------------
   Start NdbTransaction 
   Fetch needed auto-increment values
   Prepare each operation (synchronous)
   Execute the NdbTransaction
   If transaction is executed Commit or Rollback, it will close
   Attach results to operations, and run operation callbacks
   Run the transaction callback
   
   EXECUTE PATH FOR SCAN OPERATIONS
   --------------------------------
   Start NdbTransaction 
   Prepare the NdbScanOperation (async)
   Execute NdbTransaction NoCommit
   Fetch results from scan
   Execute the NdbTransaction (commit or rollback); it will close
   Attach results to query operation
   Run query operation callback
   Run the transaction callback
*/


/* Common callback for execute, commit, and rollback 
*/
function onExecute(dbTxHandler, execMode, err, execId, userCallback) {
  var apiCall;
  /* Update our own success and error objects */
  attachErrorToTransaction(dbTxHandler, err);
  if(udebug.is_debug()) {
    udebug.log("onExecute", modeNames[execMode], dbTxHandler.moniker,
                "success:", dbTxHandler.success);
  }

  /* If we just executed with Commit or Rollback, 
     register the DBTransactionHandler as closed with DBSession
  */
  if(execMode !== NOCOMMIT && dbTxHandler.ndbtx) {
    ndbsession.closeNdbTransaction(dbTxHandler, dbTxHandler.nTxRecords);
  }

  /* send the next exec call on its way */
  runExecAfterOpenQueue(dbTxHandler);

  /* Attach results to their operations */
  ndboperation.completeExecutedOps(dbTxHandler, execMode, 
                                   dbTxHandler.pendingOpsLists[execId]);
  /* Next callback */
  if(typeof userCallback === 'function') {
    userCallback(dbTxHandler.error, dbTxHandler);
  }
}


function getExecIdForOperationList(self, operationList, pendingOpsSet) {
  var execId = self.execCount++;
  self.pendingOpsLists[execId] = {
    "operationList"       : operationList,
    "pendingOperationSet" : pendingOpsSet
  };
  return execId;
}


/* NOTE: Until we have a Batch.createQuery() API, there will only ever be
   one scan in an operationList.  And there will never be key operations
   and scans combined in a single operationList.
*/

function executeScan(self, execMode, abortFlag, dbOperationList, callback) {
  var op = dbOperationList[0];
  var execId = getExecIdForOperationList(self, dbOperationList, null);

  /* Execute NdbTransaction after reading from scan */
  function executeNdbTransaction() {
    if(udebug.is_debug()) udebug.log(self.moniker, "executeScan executeNdbTransaction");

    function onCompleteExec(err) {
      onExecute(self, execMode, err, execId, callback);
    }
    
    run(self, execMode, abortFlag, onCompleteExec);
  }

  function canRetry(err) {
    return (err.ndb_error && err.ndb_error.classification == 'TimeoutExpired'
            && self.retries++ < 10);
  }


  /* Fetch is complete. */
  function onFetchComplete(err) {
    var closeScanopCallback;

    function retryAfterClose() {
      op.ndbScanOp = null;
      if(udebug.is_debug()) udebug.log(self.moniker, "retrying scan:", self.retries);
      executeScan(self, execMode, abortFlag, dbOperationList, callback);
    }
    
    function closeWithError() {
      op.result.success = false;
      op.result.error = err;
      onExecute(self, ROLLBACK, err, execId, callback);
    }

    function closeSuccess() {
      if(execMode == NOCOMMIT) {
        onExecute(self, execMode, err, execId, callback);      
      } else {
        executeNdbTransaction();
      }    
    }

    if(err) {
      closeScanopCallback = canRetry(err) ? retryAfterClose : closeWithError;
    } else {
      closeScanopCallback = closeSuccess;
    }

    op.ndbScanOp.close(false, false, closeScanopCallback);
  }
  
  /* Fetch results */
  function getScanResults(err) {
    if(udebug.is_debug()) udebug.log(self.moniker, "executeScan getScanResults");
    if(err) {
      onFetchComplete(err);
    }
    else {
      ndboperation.getScanResults(op, onFetchComplete);
    }
  }
  
  /* Execute NoCommit so that you can start reading from scans */
  function executeScanNoCommit(err, ndbScanOp) {
    var fatalError;
    if(udebug.is_debug()) udebug.log(self.moniker, "executeScan executeScanNoCommit");
    if(! ndbScanOp) {
      fatalError = self.ndbtx.getNdbError();
      callback(new ndboperation.DBOperationError().fromNdbError(fatalError), self);
      return;  /* is that correct? */
    }

    op.ndbScanOp = ndbScanOp;
    run(self, NOCOMMIT, AO_IGNORE, getScanResults);
  }

  /* executeScan() starts here */
  if(udebug.is_debug()) udebug.log(self.moniker, "executeScan");
  op.prepareScan(self.ndbtx, executeScanNoCommit);
}


function executeNonScan(self, execMode, abortFlag, dbOperationList, callback) {
  var pendingOperationSet;

  function executeNdbTransaction() {
    var execId = getExecIdForOperationList(self, dbOperationList, pendingOperationSet);

    function onCompleteExec(err) {
      onExecute(self, execMode, err, execId, callback);
    }
    
    run(self, execMode, abortFlag, onCompleteExec);
  }

  function prepareOperations() {
    udebug.log("executeNonScan prepareOperations", self.moniker);
    var i, op, fatalError;
    pendingOperationSet = ndboperation.prepareOperations(self.ndbtx, dbOperationList);
    executeNdbTransaction();
  }

  function getAutoIncrementValues() {
    var autoIncHandler = new AutoIncHandler(dbOperationList);
    if(autoIncHandler.values_needed > 0) {
      if(udebug.is_debug()) {
        udebug.log("executeNonScan getAutoIncrementValues", autoIncHandler.values_needed);
      }
      autoIncHandler.getAllValues(prepareOperations);
    }
    else {
      prepareOperations();
    }  
  }

  getAutoIncrementValues();
}


/* Internal execute()
*/ 
function execute(self, execMode, abortFlag, dbOperationList, callback) {
  var startTxCall, queueItem;
  var isScan = dbOperationList[0].isScanOperation();
  self.nTxRecords = isScan ? 2 : 1;

  function executeSpecific() {
   if(isScan) {
      executeScan(self, execMode, abortFlag, dbOperationList, callback);
    }
    else {
      executeNonScan(self, execMode, abortFlag, dbOperationList, callback);
    }
  }

  function onStartTx(err, ndbtx) {
    if(err) {
      ndbsession.closeNdbTransaction(self, self.nTxRecords);
      if(udebug.is_debug()) udebug.log("execute onStartTx [ERROR].", err);
      if(callback) {
        err = new ndboperation.DBOperationError().fromNdbError(err.ndb_error);
        callback(err, self);
      }
      return;
    }

    self.ndbtx = ndbtx;
    if(udebug.is_debug()) udebug.log("execute onStartTx. ", self.moniker, 
                                     " TC node:", ndbtx.getConnectedNodeId(),
                                     "operations:",  dbOperationList.length);
    executeSpecific();
  }

  if(self.ndbtx) {                   /* startTransaction has returned */
    executeSpecific();
  }
  else if(self.sentNdbStartTx) {     /* startTransaction has not yet returned */
    queueItem = { dbOperationList: dbOperationList, callback: callback };
    self.execAfterOpenQueue.push(queueItem);
  }
  else {                             /* call startTransaction */
    self.sentNdbStartTx = true;
    startTxCall = new QueuedAsyncCall(self.dbSession.execQueue, onStartTx);
    startTxCall.table = dbOperationList[0].tableHandler.dbTable;
    startTxCall.ndb = self.dbSession.impl;
    startTxCall.description = "startNdbTransaction";
    startTxCall.nTxRecords = self.nTxRecords;
    startTxCall.run = function() {
      // TODO: partitionKey
      this.ndb.startTransaction(this.table, 0, 0, this.callback);
    };
    
    ndbsession.queueStartNdbTransaction(self, startTxCall);
  }
}


/* execute(DBOperation[] dbOperationList,
           function(error, DBTransactionHandler) callback)
   ASYNC
   
   Executes the DBOperations in dbOperationList.
   Commits the transaction if autocommit is true.
*/
proto.execute = function(dbOperationList, userCallback) {

  if(! dbOperationList.length) {
    if(udebug.is_debug()) udebug.log("Execute -- STUB EXECUTE (no operation list)");
    userCallback(null, this);
    return;
  }
  
  if(this.autocommit) {
    if(udebug.is_debug()) udebug.log("Execute -- AutoCommit", this.moniker);
    stats.execute.commit++;
    ndbsession.closeActiveTransaction(this);
    execute(this, COMMIT, AO_IGNORE, dbOperationList, userCallback);
  }
  else {
    if(udebug.is_debug()) udebug.log("Execute -- NoCommit", this.moniker);
    stats.execute.no_commit++;
    execute(this, NOCOMMIT, AO_IGNORE, dbOperationList, userCallback);
  }
};


/* commit(function(error, DBTransactionHandler) callback)
   ASYNC 
   
   Commit work.
*/
proto.commit = function commit(userCallback) {
  assert(this.autocommit === false);
  stats.commit++;
  var self = this;
  var execId = getExecIdForOperationList(self, [], null);

  function onNdbCommit(err) {
    onExecute(self, COMMIT, err, execId, userCallback);
  }

  /* commit begins here */
  if(udebug.is_debug()) udebug.log("commit");
  ndbsession.closeActiveTransaction(this);
  if(self.ndbtx) {  
    run(self, COMMIT, AO_IGNORE, onNdbCommit);
  }
  else {
    if(udebug.is_debug()) udebug.log("commit STUB COMMIT (no underlying NdbTransaction)");
    onNdbCommit();
  }
};


/* rollback(function(error, DBTransactionHandler) callback)
   ASYNC 
   
   Roll back all previously executed operations.
*/
proto.rollback = function rollback(callback) {
  assert(this.autocommit === false);
  stats.rollback++;
  var self = this;
  var execId = getExecIdForOperationList(self, [], null);

  ndbsession.closeActiveTransaction(this);

  function onNdbRollback(err) {
    onExecute(self, ROLLBACK, err, execId, callback);
  }

  /* rollback begins here */
  if(udebug.is_debug()) udebug.log("rollback");

  if(self.ndbtx) {
    run(self, ROLLBACK, AO_DEFAULT, onNdbRollback);
  }
  else {
    if(udebug.is_debug()) udebug.log("rollback STUB ROLLBACK (no underlying NdbTransaction)");
    onNdbRollback();
  }
};


DBTransactionHandler.prototype = proto;
exports.DBTransactionHandler = DBTransactionHandler;

