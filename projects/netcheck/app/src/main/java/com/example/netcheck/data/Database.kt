package com.example.netcheck.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

/**
 * FR-06: one row per saved test. Column names and types follow the documented
 * data model; the nullable ping columns are exactly the values that can be
 * unknown when every sample is lost.
 */
@Entity(tableName = "test_results")
data class TestRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val timestamp: Long,
    val connectionType: String,
    val pingAvgMs: Double?,
    val jitterMs: Double?,
    val packetLossPercent: Double,
    val sitesOk: Int,
    val sitesTotal: Int,
)

@Dao
interface TestRecordDao {

    /** FR-07: newest first, and live — the history tab never re-queries by hand. */
    @Query("SELECT * FROM test_results ORDER BY timestamp DESC")
    fun observeNewestFirst(): Flow<List<TestRecord>>

    @Insert
    suspend fun insert(record: TestRecord): Long

    /** FR-08. */
    @Query("DELETE FROM test_results")
    suspend fun clearAll()
}

@Database(entities = [TestRecord::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {

    abstract fun testRecordDao(): TestRecordDao

    companion object {
        @Volatile
        private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "netcheck.db",
                ).build().also { instance = it }
            }
    }
}
