/** Isolated SQLite planning-store adapter. Caller owns the database lifecycle.
 * No production connection, migrations or execution authority are opened here.
 * Requires a SQLite connection exposing prepare(sql).run/get and exec(sql).
 */
export class SqliteTaasStore {
  constructor(db,{table='taas_planning_candidates'}={}){
    if(!db||typeof db.prepare!=='function'||typeof db.exec!=='function'||table!=='taas_planning_candidates')throw new TypeError('SQLITE_STORE_REQUIRED');
    this.db=db;
    const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='taas_planning_candidates'").get();
    if(existing){
      const columns=db.prepare('PRAGMA table_info(taas_planning_candidates)').all();
      const required=['candidate_id','revision','state','record_json'];
      if(columns.length!==4 || required.some(name=>!columns.some(column=>column.name===name)))throw new TypeError('INCOMPATIBLE_SCHEMA');
    }
    db.exec('CREATE TABLE IF NOT EXISTS taas_planning_candidates (candidate_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL)');
    this.getStmt=db.prepare('SELECT record_json FROM taas_planning_candidates WHERE candidate_id = ?');
    this.insertStmt=db.prepare('INSERT OR IGNORE INTO taas_planning_candidates (candidate_id,revision,state,record_json) VALUES (?,?,?,?)');
    this.casStmt=db.prepare('UPDATE taas_planning_candidates SET revision=?,state=?,record_json=? WHERE candidate_id=? AND revision=? AND state=?');
  }
  async get(key){
    const row=this.getStmt.get(key);
    if(!row)return null;
    const value=JSON.parse(row.record_json);
    if(value.candidate?.candidateId!==key || !Number.isSafeInteger(value.revision) || typeof value.state!=='string')throw new TypeError('CORRUPT_RECORD');
    return value;
  }
  async insertIfAbsent(key,value){
    if(!value||value.candidate?.candidateId!==key||value.revision!==0||value.state!=='DISCOVERED')throw new TypeError('INVALID_INSERT');
    const result=this.insertStmt.run(key,0,'DISCOVERED',JSON.stringify(value));
    return {inserted:result.changes===1};
  }
  async compareAndSwap(key,revision,value,expectedState){
    if(!Number.isSafeInteger(revision)||revision<0||!value||value.candidate?.candidateId!==key||value.revision!==revision+1||typeof expectedState!=='string'||!expectedState||typeof value.state!=='string')throw new TypeError('INVALID_CAS');
    const result=this.casStmt.run(value.revision,value.state,JSON.stringify(value),key,revision,expectedState);
    return result.changes===1;
  }
}
