# 把联系人恢复到升级前（手动恢复联系人升级的备份）

> 创建：2026-11-15 · 最后更新：2026-11-16（加了「升级之后的修补」）
> 对应 ADR-091（`user_version` 4 → 5，「每个联系人都按地址」）和 ADR-083（3 → 4，「每个地址各有自己的联系人」）。只在升级之后联系人、好友请求明显不对，需要退回上一个版本时才用；平时不需要做任何事。**两次升级的备份要倒着恢复**：先恢复 5 → 4（下面第一部分），还要再退的话再恢复 4 → 3（第二部分）。

## 第一部分：「每个联系人都按地址」这次升级（v5）

升级到删掉 v2 的版本时（ADR-091），第一次打开信箱会把数据库从 4 升到 5，命令行里说一次 `morse: old names are gone — … backup <路径>`，之后 `morse status` 的 `contacts: reached by address … backup <路径>` 那一行也会写。备份在下面两个位置之一：

| 位置 | 什么时候 |
| --- | --- |
| `~/.morse/backups/remove-v2-<UTC 时间>/tables.sqlite`（旁边有 `MANIFEST.json`） | 正常情况 |
| `~/.morse/mailbox.db.v4-contacts.bak` | `~/.morse/backups` 写不进去时退到这里 |

里面是升级改写的 5 张表在升级前的样子（`contacts`、`contact_addresses`、`morse_requests`、`address_blocks`、`migration_marks`，连同建表和建索引的语句），以及 `changed_messages`：被改过的那些消息原来的联系人和收件人（`id`、`contact_id`、`to_device`）。消息正文没有被改过，也不在备份里；`config.json`、`morse-blocked.json`、`trusted-devices.json`、`peer-keys.json` 这次升级都没有动过。

恢复之后会少什么：升级之后新加的联系人、备注、分组、好友请求和拉黑都没有了（这 5 张表整个换回升级前的样子）；升级后收发的消息还在，属于升级后才有的联系人的那些不挂在任何联系人下面。恢复之后**必须运行上一个版本**（新版本一打开信箱就会再升级一次）。

步骤（第 1、5、6 步和第二部分一样）：

```sh
morse stop
DB=~/.morse/mailbox.db
BAK="$(ls -d ~/.morse/backups/remove-v2-*/ | tail -1)tables.sqlite"
# 备份在数据库旁边时改用：BAK=~/.morse/mailbox.db.v4-contacts.bak
sqlite3 "$BAK" "PRAGMA user_version; SELECT count(*) FROM contacts; SELECT count(*) FROM changed_messages;"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" && cp -p "$DB" "$DB.before-restore"
{
  echo "ATTACH DATABASE '$BAK' AS bak;"
  echo "BEGIN IMMEDIATE;"
  for t in contacts contact_addresses morse_requests address_blocks migration_marks; do echo "DROP TABLE IF EXISTS main.$t;"; done
  sqlite3 "$BAK" "SELECT sql || ';' FROM sqlite_master WHERE type = 'table' AND name != 'changed_messages';"
  for t in contacts contact_addresses morse_requests address_blocks migration_marks; do echo "INSERT INTO main.$t SELECT * FROM bak.$t;"; done
  sqlite3 "$BAK" "SELECT sql || ';' FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL;"
  echo "UPDATE main.messages SET contact_id = (SELECT c.contact_id FROM bak.changed_messages c WHERE c.id = messages.id), to_device = (SELECT c.to_device FROM bak.changed_messages c WHERE c.id = messages.id) WHERE id IN (SELECT id FROM bak.changed_messages);"
  echo "PRAGMA main.user_version = 4;"
  echo "COMMIT;"
} | sqlite3 -bail "$DB"
sqlite3 "$DB" "PRAGMA user_version; PRAGMA integrity_check; SELECT count(*) FROM contacts;"
```

第一条检查应先输出 `4`；最后一条应输出 `4`、`ok` 和备份里的联系人条数。然后照第二部分第 6 步关掉自动更新、装回上一个版本再启动。备份在数据库旁边时，用过之后把它挪开（`mv ~/.morse/mailbox.db.v4-contacts.bak ~/.morse/mailbox.db.v4-contacts.bak.used`）。

### 升级之后的修补（ADR-091 第 2 期发布后的修补）

再下一版第一次打开信箱时（已经升到 v5 的和刚升级的都一样），会做一次修补，命令行里可能说一次 `morse: follow-up to the address upgrade — …`。它改的东西和改之前的值写在 `~/.morse/backups/repair-remove-v2-<UTC 时间>/changes.json`（`before` 里），同样的内容也记在 `migration_marks` 的 `p5.repair.1` 那一行：

- `remarks`：没备注、用旧名字当了备注的联系人（恢复上面的 5 张表时自然回到没有备注）；
- `keys`：新表 `contact_old_keys` 里加的查设置用的键（可以整张表删掉：`DROP TABLE contact_old_keys;`）；
- `tiers`：从自己别的电脑来的消息，`from_tier` 从 `owner` 改成了 `peer`；
- `failed`：写给旧名字、被上一版错记成已送到的消息，改成了 `dead`（原来的 `status` 和 `last_error` 在 `before` 里）；
- `selfAgents`：「你」那一行残留的 `contact_agents`（原来的行在 `before` 里）。

要连修补一起退回，先按上面恢复 5 → 4，再按 `changes.json` 把 `tiers`、`failed` 里列的消息改回原值（`UPDATE messages SET from_tier = 'owner' WHERE id = '…';`，`UPDATE messages SET status = '…', last_error = … WHERE id = '…';`），把 `selfAgents` 的行插回 `contact_agents`。不退回也不影响上一个版本运行。

## 第二部分：「每个地址各有自己的联系人」这次升级（v4）

### 这份备份是什么

升级到「联系人按你的每个地址分开」的版本时，Morse 第一次打开信箱会把数据库从 `user_version` 3 升到 4，升级前先留一份备份，并在命令行里说一次备份在哪（之后 `morse status` 的 `contacts: kept per address of yours … backup <路径>` 那一行也会写）。备份只在下面两个位置之一：

| 位置 | 什么时候 |
| --- | --- |
| `~/.morse/backups/contacts-per-address-<UTC 时间>/tables.sqlite`（旁边有 `MANIFEST.json`） | 正常情况 |
| `~/.morse/mailbox.db.v3-contacts.bak` | `~/.morse/backups` 写不进去时退到这里 |

两处的内容一样，都是一个小的 SQLite 文件：

- 升级改写的 5 张表在升级前的样子，连同建表和建索引的语句：`contacts`、`contact_agents`、`contact_addresses`、`morse_requests`、`migration_marks`；
- `repointed_messages`：被改挂到另一条联系人下面的那些消息，原来挂在哪条联系人下（`id`、`contact_id`）。消息正文没有被改过，也不在备份里。

### 恢复之后会少什么

- **升级之后新加的联系人、备注、分组、好友请求、拉黑和删除记录都没有了**——这 5 张表整个换回升级前的样子。
- 升级后才有的 `address_blocks` 表（按地址的拉黑）会被删掉；升级前的拉黑还在 `~/.morse/morse-blocked.json` 里，没动过。
- 升级之后收发的消息还在，但其中属于「升级后才有的联系人」的那些，恢复后不挂在任何联系人下面（`morse read` 里还看得到，`morse contact <谁>` 里看不到）。
- 恢复之后**必须运行上一个版本**。新版本一打开信箱就会再升级一次（再留一份新备份）。

### 步骤

下面的命令原样复制即可；只有第 2 步要按你的备份位置选一行。

**1. 停掉 daemon，并确认没有别的 `morse` 命令在跑**

```sh
morse stop
```

**2. 指明数据库和备份**

```sh
DB=~/.morse/mailbox.db
# 正常位置（取最新的一份）：
BAK="$(ls -d ~/.morse/backups/contacts-per-address-*/ | tail -1)tables.sqlite"
# 如果你的备份在数据库旁边，改用这一行：
# BAK=~/.morse/mailbox.db.v3-contacts.bak
```

**3. 看一眼备份是对的，并先给现在的数据库留个副本**

```sh
sqlite3 "$BAK" "PRAGMA user_version; SELECT count(*) FROM contacts; SELECT count(*) FROM repointed_messages;"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" && cp -p "$DB" "$DB.before-restore"
```

第一条应先输出 `3`（备份是升级前的版本），再输出联系人条数和被改挂的消息条数；第二条会输出一行 `0|0|0`（检查点的结果，正常）。

**4. 恢复（一个事务：要么全部换回，要么什么都不变）**

```sh
{
  echo "ATTACH DATABASE '$BAK' AS bak;"
  echo "BEGIN IMMEDIATE;"
  echo "DROP TABLE IF EXISTS main.address_blocks;"
  for t in contacts contact_agents contact_addresses morse_requests migration_marks; do echo "DROP TABLE IF EXISTS main.$t;"; done
  sqlite3 "$BAK" "SELECT sql || ';' FROM sqlite_master WHERE type = 'table' AND name != 'repointed_messages';"
  for t in contacts contact_agents contact_addresses morse_requests migration_marks; do echo "INSERT INTO main.$t SELECT * FROM bak.$t;"; done
  sqlite3 "$BAK" "SELECT sql || ';' FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL;"
  echo "UPDATE main.messages SET contact_id = (SELECT r.contact_id FROM bak.repointed_messages r WHERE r.id = messages.id) WHERE id IN (SELECT id FROM bak.repointed_messages);"
  echo "PRAGMA main.user_version = 3;"
  echo "COMMIT;"
} | sqlite3 -bail "$DB"
```

**5. 检查**

```sh
sqlite3 "$DB" "PRAGMA user_version; PRAGMA integrity_check; SELECT count(*) FROM contacts;"
```

应输出 `3`、`ok` 和第 3 步看到的联系人条数。

**6. 换回上一个版本再启动**

- 先关掉自动更新，否则 daemon 会自己升回新版本、再升级一次数据库：在 `~/.morse/config.json` 里写 `"update": { "auto": false }`。
- 装回上一个版本，然后 `morse start`。
- 如果你用的是数据库旁边那份备份，把它挪开（`mv ~/.morse/mailbox.db.v3-contacts.bak ~/.morse/mailbox.db.v3-contacts.bak.used`）：以后再升级时，如果备份又只能写在数据库旁边，Morse 不会覆盖已有的那一份，会报错并且不升级。
- 确认一切正常后，`~/.morse/mailbox.db.before-restore` 可以删掉。想撤销这次恢复：停掉 daemon，把它拷回 `~/.morse/mailbox.db`（并删掉 `mailbox.db-wal`、`mailbox.db-shm`）。

### 没有 `sqlite3` 命令时

macOS 自带 `sqlite3`。没有的话，用 Morse 自己带的 `better-sqlite3` 做同样的事——进到 Morse 的安装目录再运行（第 1、2、6 步不变；`$DB`、`$BAK` 照第 2 步设好）：

```sh
cd "$(npm root -g)/anytoany"
DB="$DB" BAK="$BAK" node -e '
const Database = require("better-sqlite3");
const fs = require("node:fs");
const { DB, BAK } = process.env;
const TABLES = ["contacts", "contact_agents", "contact_addresses", "morse_requests", "migration_marks"];
const bak = new Database(BAK, { readonly: true });
if (bak.pragma("user_version", { simple: true }) !== 3) throw new Error("this is not a backup of user_version 3");
const ddl = (type) => bak.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND name != ?").all(type, "repointed_messages").map((r) => r.sql);
const tables = ddl("table"), indexes = ddl("index");
bak.close();
const db = new Database(DB);
db.pragma("wal_checkpoint(TRUNCATE)");
fs.copyFileSync(DB, DB + ".before-restore");
db.prepare("ATTACH DATABASE ? AS bak").run(BAK);
db.exec([
  "BEGIN IMMEDIATE",
  "DROP TABLE IF EXISTS main.address_blocks",
  ...TABLES.map((t) => "DROP TABLE IF EXISTS main." + t),
  ...tables,
  ...TABLES.map((t) => "INSERT INTO main." + t + " SELECT * FROM bak." + t),
  ...indexes,
  "UPDATE main.messages SET contact_id = (SELECT r.contact_id FROM bak.repointed_messages r WHERE r.id = messages.id) WHERE id IN (SELECT id FROM bak.repointed_messages)",
  "PRAGMA main.user_version = 3",
  "COMMIT",
].join(";\n"));
console.log("user_version", db.pragma("user_version", { simple: true }), "integrity", db.pragma("integrity_check", { simple: true }), "contacts", db.prepare("SELECT count(*) AS n FROM contacts").get().n);
db.close();
'
```

应输出 `user_version 3 integrity ok contacts <条数>`。

## 这份指南不包括什么

- **更早那次升级的备份**（`~/.morse/backups/identity-v3-p2-<UTC 时间>/contacts.sqlite`，或 `~/.morse/mailbox.db.v2-contacts.bak`；ADR-077，`user_version` 2 → 3）**不能用上面的步骤恢复**：那份备份只有 3 张联系人表、没有索引定义，还另外带着几个 JSON 文件的副本，退回去的是再上一个版本。这里不覆盖。
- 密钥、地址、消息正文都不在这份备份里，这次升级也没有动过它们。
