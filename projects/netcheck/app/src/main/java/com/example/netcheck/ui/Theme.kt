package com.example.netcheck.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * A deliberately small theme: Material3 defaults with a blue-ish primary that
 * reads clearly in the quality badges. No custom typography for v1.
 */
private val NetCheckColors = lightColorScheme(
    primary = Color(0xFF1B5E9C),
    onPrimary = Color.White,
    secondary = Color(0xFF3F6C85),
    background = Color(0xFFF6F7F9),
    surface = Color.White,
)

@Composable
fun NetCheckTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = NetCheckColors, content = content)
}
