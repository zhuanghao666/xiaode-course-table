package com.xiaode.importhelper

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "accounts",
    indices = [Index("username"), Index("tokenHash"), Index("isCurrent")]
)
data class AccountEntity(
    @PrimaryKey val accountId: String,
    val userId: String = "",
    val username: String = "",
    val name: String = "",
    val switchKey: String = "",
    val tokenHash: String = "",
    val activeTermKey: String = "",
    val isCurrent: Boolean = false,
    val revision: Long = 1,
    val updatedAt: String = ""
)

@Entity(
    tableName = "terms",
    indices = [Index(value = ["accountId", "termKey"], unique = true), Index("accountId")]
)
data class TermEntity(
    @PrimaryKey val termRowId: String,
    val accountId: String,
    val termKey: String,
    val selectedTermLabel: String = "",
    val xnm: String = "",
    val xqm: String = "",
    val termStart: String = "",
    val termStartStatus: String = "unknown",
    val totalWeeks: Int = 20,
    val totalWeeksSource: String = "",
    val scheduleTemplateId: String = "legacy-default",
    val active: Boolean = false,
    val revision: Long = 1,
    val updatedAt: String = ""
)

@Entity(
    tableName = "courses",
    indices = [
        Index(value = ["accountId", "termKey"]),
        Index(value = ["accountId", "serverId"]),
        Index(value = ["accountId", "clientLocalId"])
    ]
)
data class CourseEntity(
    @PrimaryKey val localId: String,
    val accountId: String,
    val termKey: String,
    val serverId: String = "",
    val clientLocalId: String = localId,
    val name: String,
    val shortName: String = "",
    val teacher: String = "",
    val location: String = "",
    val room: String = "",
    val classGroup: String = "",
    val day: Int,
    val sourceStartSlot: Int,
    val sourceEndSlot: Int,
    val startSlot: Int,
    val endSlot: Int,
    val startSlotKey: String = "",
    val endSlotKey: String = "",
    val scheduleTemplateId: String = "legacy-default",
    val weekText: String = "",
    val weeksJson: String = "[]",
    val oddEven: String = "all",
    val category: String = "custom",
    val source: String = "",
    val sourceIdsJson: String = "[]",
    val underlyingIdsJson: String = "[]",
    val scheduleVariantsJson: String = "[]",
    val revision: Long = 0,
    val createdAt: String = "",
    val updatedAt: String = "",
    val syncState: String = "SYNCED",
    val isDeleted: Boolean = false
)

@Entity(
    tableName = "slot_templates",
    indices = [Index(value = ["accountId", "templateId"], unique = true), Index("termKey")]
)
data class SlotTemplateEntity(
    @PrimaryKey val templateRowId: String,
    val templateId: String,
    val accountId: String,
    val termKey: String = "",
    val name: String,
    val templateJson: String,
    val revision: Long = 1,
    val updatedAt: String = ""
)

@Entity(tableName = "preferences")
data class PreferenceEntity(
    @PrimaryKey val accountId: String,
    val preferencesJson: String = "{}",
    val revision: Long = 1,
    val updatedAt: String = ""
)

@Entity(tableName = "sync_metadata")
data class SyncMetadataEntity(
    @PrimaryKey val accountId: String,
    val serverUrl: String = "",
    val status: String = "LOCAL",
    val lastError: String = "",
    val lastPushAt: Long = 0,
    val lastPullAt: Long = 0,
    val lastAttemptAt: Long = 0
)

@Entity(
    tableName = "pending_mutations",
    indices = [Index(value = ["accountId", "createdAt"]), Index(value = ["accountId", "entityType", "entityLocalId"])]
)
data class PendingMutationEntity(
    @PrimaryKey val operationId: String,
    val accountId: String,
    val termKey: String = "",
    val entityType: String,
    val entityLocalId: String = "",
    val serverId: String = "",
    val operationType: String,
    val baseRevision: Long = 0,
    val payloadJson: String,
    val createdAt: Long,
    val attemptCount: Int = 0,
    val lastError: String = "",
    val state: String = "PENDING"
)

@Entity(
    tableName = "sync_conflicts",
    indices = [Index("accountId"), Index("operationId")]
)
data class SyncConflictEntity(
    @PrimaryKey val conflictId: String,
    val operationId: String,
    val accountId: String,
    val termKey: String = "",
    val entityType: String,
    val entityLocalId: String = "",
    val localJson: String,
    val serverJson: String,
    val reason: String,
    val createdAt: Long,
    val resolvedAt: Long = 0
)
