package com.rix.vpn.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp

object RixColors {
    val Background = Color(0xFF07070D)
    val BackgroundLift = Color(0xFF0B0B16)
    val Surface = Color(0xFF10101F)
    val SurfaceHigh = Color(0xFF17172B)
    val Stroke = Color(0xFF23233C)

    val Violet = Color(0xFF8F7BFF)
    val VioletDeep = Color(0xFF5B45D6)
    val Teal = Color(0xFF2BD9C4)
    val TealDeep = Color(0xFF12A08F)

    val Text = Color(0xFFEFEDFF)
    val TextMuted = Color(0xFF8E8BAD)
    val Danger = Color(0xFFFF5C7A)
    val Warning = Color(0xFFFFC46B)
}

private val RixDarkScheme = darkColorScheme(
    primary = RixColors.Violet,
    onPrimary = Color(0xFF0B0616),
    primaryContainer = RixColors.VioletDeep,
    onPrimaryContainer = RixColors.Text,
    secondary = RixColors.Teal,
    onSecondary = Color(0xFF00201C),
    background = RixColors.Background,
    onBackground = RixColors.Text,
    surface = RixColors.Surface,
    onSurface = RixColors.Text,
    surfaceVariant = RixColors.SurfaceHigh,
    onSurfaceVariant = RixColors.TextMuted,
    outline = RixColors.Stroke,
    error = RixColors.Danger,
    onError = Color(0xFF2A0010)
)

private val RixTypography = Typography(
    displaySmall = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.SemiBold),
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium)
)

/**
 * Forces RTL because every label in this app is Persian.
 *
 * The OS layout direction follows the device locale, so a phone set to English
 * would lay Persian text out left-to-right and every row would look wrong. Text
 * that must stay left-to-right (addresses, ports, logs) opts out locally with
 * `textDirection = TextDirection.Ltr`.
 */
@Composable
fun RixTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(
            colorScheme = RixDarkScheme,
            typography = RixTypography,
            content = content
        )
    }
}