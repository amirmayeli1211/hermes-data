package com.example.netcheck

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.netcheck.ui.NetCheckApp
import com.example.netcheck.ui.NetCheckTheme
import com.example.netcheck.viewmodel.NetCheckViewModel

/**
 * Single entry point: one Activity, one Compose tree.
 *
 * The layout direction is forced to RTL rather than left to the device locale,
 * because every string in v1 is Persian and a left-to-right layout would mirror
 * the cards against the text.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            NetCheckTheme {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    val viewModel: NetCheckViewModel = viewModel()
                    NetCheckApp(viewModel)
                }
            }
        }
    }
}
