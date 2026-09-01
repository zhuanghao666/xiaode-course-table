package com.xiaode.importhelper

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        AccountEntity::class,
        TermEntity::class,
        CourseEntity::class,
        SlotTemplateEntity::class,
        PreferenceEntity::class,
        SyncMetadataEntity::class,
        PendingMutationEntity::class,
        SyncConflictEntity::class
    ],
    version = 2,
    exportSchema = true
)
abstract class XiaoDeDatabase : RoomDatabase() {
    abstract fun dao(): XiaoDeDao

    companion object {
        @Volatile private var instance: XiaoDeDatabase? = null

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // v1 was an unreleased bootstrap. These IF NOT EXISTS statements also make
                // upgrades from installations without a Room database non-destructive.
                db.execSQL("CREATE TABLE IF NOT EXISTS `accounts` (`accountId` TEXT NOT NULL, `userId` TEXT NOT NULL, `username` TEXT NOT NULL, `name` TEXT NOT NULL, `switchKey` TEXT NOT NULL, `tokenHash` TEXT NOT NULL, `activeTermKey` TEXT NOT NULL, `isCurrent` INTEGER NOT NULL, `revision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`accountId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_accounts_username` ON `accounts` (`username`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_accounts_tokenHash` ON `accounts` (`tokenHash`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_accounts_isCurrent` ON `accounts` (`isCurrent`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `terms` (`termRowId` TEXT NOT NULL, `accountId` TEXT NOT NULL, `termKey` TEXT NOT NULL, `selectedTermLabel` TEXT NOT NULL, `xnm` TEXT NOT NULL, `xqm` TEXT NOT NULL, `termStart` TEXT NOT NULL, `termStartStatus` TEXT NOT NULL, `totalWeeks` INTEGER NOT NULL, `totalWeeksSource` TEXT NOT NULL, `scheduleTemplateId` TEXT NOT NULL, `active` INTEGER NOT NULL, `revision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`termRowId`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_terms_accountId_termKey` ON `terms` (`accountId`, `termKey`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_terms_accountId` ON `terms` (`accountId`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `courses` (`localId` TEXT NOT NULL, `accountId` TEXT NOT NULL, `termKey` TEXT NOT NULL, `serverId` TEXT NOT NULL, `clientLocalId` TEXT NOT NULL, `name` TEXT NOT NULL, `shortName` TEXT NOT NULL, `teacher` TEXT NOT NULL, `location` TEXT NOT NULL, `room` TEXT NOT NULL, `classGroup` TEXT NOT NULL, `day` INTEGER NOT NULL, `sourceStartSlot` INTEGER NOT NULL, `sourceEndSlot` INTEGER NOT NULL, `startSlot` INTEGER NOT NULL, `endSlot` INTEGER NOT NULL, `startSlotKey` TEXT NOT NULL, `endSlotKey` TEXT NOT NULL, `scheduleTemplateId` TEXT NOT NULL, `weekText` TEXT NOT NULL, `weeksJson` TEXT NOT NULL, `oddEven` TEXT NOT NULL, `category` TEXT NOT NULL, `source` TEXT NOT NULL, `sourceIdsJson` TEXT NOT NULL, `underlyingIdsJson` TEXT NOT NULL, `scheduleVariantsJson` TEXT NOT NULL, `revision` INTEGER NOT NULL, `createdAt` TEXT NOT NULL, `updatedAt` TEXT NOT NULL, `syncState` TEXT NOT NULL, `isDeleted` INTEGER NOT NULL, PRIMARY KEY(`localId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_courses_accountId_termKey` ON `courses` (`accountId`, `termKey`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_courses_accountId_serverId` ON `courses` (`accountId`, `serverId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_courses_accountId_clientLocalId` ON `courses` (`accountId`, `clientLocalId`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `slot_templates` (`templateRowId` TEXT NOT NULL, `templateId` TEXT NOT NULL, `accountId` TEXT NOT NULL, `termKey` TEXT NOT NULL, `name` TEXT NOT NULL, `templateJson` TEXT NOT NULL, `revision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`templateRowId`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_slot_templates_accountId_templateId` ON `slot_templates` (`accountId`, `templateId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_slot_templates_termKey` ON `slot_templates` (`termKey`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `preferences` (`accountId` TEXT NOT NULL, `preferencesJson` TEXT NOT NULL, `revision` INTEGER NOT NULL, `updatedAt` TEXT NOT NULL, PRIMARY KEY(`accountId`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `sync_metadata` (`accountId` TEXT NOT NULL, `serverUrl` TEXT NOT NULL, `status` TEXT NOT NULL, `lastError` TEXT NOT NULL, `lastPushAt` INTEGER NOT NULL, `lastPullAt` INTEGER NOT NULL, `lastAttemptAt` INTEGER NOT NULL, PRIMARY KEY(`accountId`))")
                db.execSQL("CREATE TABLE IF NOT EXISTS `pending_mutations` (`operationId` TEXT NOT NULL, `accountId` TEXT NOT NULL, `termKey` TEXT NOT NULL, `entityType` TEXT NOT NULL, `entityLocalId` TEXT NOT NULL, `serverId` TEXT NOT NULL, `operationType` TEXT NOT NULL, `baseRevision` INTEGER NOT NULL, `payloadJson` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `attemptCount` INTEGER NOT NULL, `lastError` TEXT NOT NULL, `state` TEXT NOT NULL, PRIMARY KEY(`operationId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_pending_mutations_accountId_createdAt` ON `pending_mutations` (`accountId`, `createdAt`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_pending_mutations_accountId_entityType_entityLocalId` ON `pending_mutations` (`accountId`, `entityType`, `entityLocalId`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `sync_conflicts` (`conflictId` TEXT NOT NULL, `operationId` TEXT NOT NULL, `accountId` TEXT NOT NULL, `termKey` TEXT NOT NULL, `entityType` TEXT NOT NULL, `entityLocalId` TEXT NOT NULL, `localJson` TEXT NOT NULL, `serverJson` TEXT NOT NULL, `reason` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `resolvedAt` INTEGER NOT NULL, PRIMARY KEY(`conflictId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_sync_conflicts_accountId` ON `sync_conflicts` (`accountId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_sync_conflicts_operationId` ON `sync_conflicts` (`operationId`)")
            }
        }

        fun get(context: Context): XiaoDeDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                XiaoDeDatabase::class.java,
                "xiaode-offline-v2.db"
            ).addMigrations(MIGRATION_1_2).build().also { instance = it }
        }

        internal fun resetForTests() = synchronized(this) {
            instance?.close()
            instance = null
        }
    }
}
