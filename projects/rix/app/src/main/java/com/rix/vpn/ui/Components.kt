package com.rix.vpn.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Near-black canvas with two soft colour wells so the UI is not flat. */
@Composable
fun RixSurface(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(RixColors.Background)
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(RixColors.Violet.copy(alpha = 0.16f), Color.Transparent),
                    center = Offset(size.width * 0.16f, size.height * 0.10f),
                    radius = size.minDimension * 0.75f
                ),
                radius = size.minDimension * 0.75f,
                center = Offset(size.width * 0.16f, size.height * 0.10f)
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(RixColors.Teal.copy(alpha = 0.10f), Color.Transparent),
                    center = Offset(size.width * 0.92f, size.height * 0.88f),
                    radius = size.minDimension * 0.65f
                ),
                radius = size.minDimension * 0.65f,
                center = Offset(size.width * 0.92f, size.height * 0.88f)
            )
        }
        content()
    }
}

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(22.dp))
            .background(
                Brush.verticalGradient(
                    listOf(RixColors.SurfaceHigh.copy(alpha = 0.92f), RixColors.Surface.copy(alpha = 0.86f))
                )
            )
            .border(1.dp, RixColors.Stroke.copy(alpha = 0.75f), RoundedCornerShape(22.dp))
            .padding(18.dp)
    ) {
        content()
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier.padding(top = 4.dp, bottom = 8.dp),
        color = RixColors.TextMuted,
        fontSize = 12.5.sp,
        fontWeight = FontWeight.Medium
    )
}

/** Monospace-ish LTR text for addresses, ports and numbers. */
@Composable
fun MonoText(
    text: String,
    color: Color = RixColors.Text,
    size: Int = 13,
    modifier: Modifier = Modifier
) {
    Text(
        text = text,
        modifier = modifier,
        color = color,
        fontSize = size.sp,
        textAlign = TextAlign.Start,
        // Text has no textDirection parameter; direction lives on the style.
        style = TextStyle(textDirection = TextDirection.Ltr)
    )
}

@Composable
fun SegmentedRow(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(RixColors.Surface)
            .border(1.dp, RixColors.Stroke, RoundedCornerShape(16.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        options.forEachIndexed { index, label ->
            val active = index == selectedIndex
            val bg by animateColorAsState(
                targetValue = if (active) RixColors.Violet.copy(alpha = 0.22f) else Color.Transparent,
                animationSpec = tween(220),
                label = "seg-bg"
            )
            val fg by animateColorAsState(
                targetValue = if (active) RixColors.Text else RixColors.TextMuted,
                animationSpec = tween(220),
                label = "seg-fg"
            )
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(12.dp))
                    .background(bg)
                    .clickable { onSelect(index) }
                    .padding(vertical = 11.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = label,
                    color = fg,
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@Composable
fun SettingSwitch(
    title: String,
    subtitle: String?,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = RixColors.Text, fontSize = 14.sp)
            if (subtitle != null) {
                Text(subtitle, color = RixColors.TextMuted, fontSize = 11.5.sp, lineHeight = 16.sp)
            }
        }
        Spacer(Modifier.width(10.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = RixColors.Background,
                checkedTrackColor = RixColors.Violet,
                uncheckedThumbColor = RixColors.TextMuted,
                uncheckedTrackColor = RixColors.SurfaceHigh,
                uncheckedBorderColor = RixColors.Stroke
            )
        )
    }
}

@Composable
fun StatTile(
    label: String,
    value: String,
    accent: Color,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(RixColors.Surface.copy(alpha = 0.75f))
            .border(1.dp, RixColors.Stroke.copy(alpha = 0.6f), RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(label, color = RixColors.TextMuted, fontSize = 11.sp)
        }
        Spacer(Modifier.height(6.dp))
        MonoText(text = value, color = RixColors.Text, size = 15)
    }
}

@Composable
fun RixChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val bg by animateColorAsState(
        targetValue = if (selected) RixColors.Violet.copy(alpha = 0.20f) else RixColors.Surface,
        animationSpec = tween(180),
        label = "chip-bg"
    )
    val border by animateColorAsState(
        targetValue = if (selected) RixColors.Violet.copy(alpha = 0.65f) else RixColors.Stroke,
        animationSpec = tween(180),
        label = "chip-border"
    )
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(bg)
            .border(1.dp, border, CircleShape)
            .clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 8.dp)
    ) {
        Text(
            label,
            color = if (selected) RixColors.Text else RixColors.TextMuted,
            fontSize = 12.5.sp,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal
        )
    }
}

/**
 * The connect orb.
 *
 * Three expanding rings tied to one infinite transition: they stay in phase so
 * the pulse reads as a single heartbeat instead of noise, and they are only
 * drawn while [active] so an idle screen is perfectly still.
 */
@Composable
fun PowerOrb(
    active: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val transition = rememberInfiniteTransition(label = "orb")
    val pulse by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(2600, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "pulse"
    )

    val accent = if (active) RixColors.Teal else RixColors.Violet

    Box(
        modifier = modifier.size(232.dp),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val base = size.minDimension / 2f

            if (active || busy) {
                repeat(3) { index ->
                    val phase = (pulse + index / 3f) % 1f
                    val radius = base * (0.58f + 0.42f * phase)
                    val alpha = (1f - phase) * 0.28f
                    drawCircle(
                        color = accent.copy(alpha = alpha),
                        radius = radius,
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2.2f)
                    )
                }
            }

            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        accent.copy(alpha = if (active) 0.30f else 0.14f),
                        Color.Transparent
                    )
                ),
                radius = base * 0.72f
            )
        }

        Box(
            modifier = Modifier
                .size(150.dp)
                .clip(CircleShape)
                .background(
                    Brush.verticalGradient(
                        listOf(
                            if (active) RixColors.TealDeep else RixColors.VioletDeep,
                            RixColors.Surface
                        )
                    )
                )
                .border(1.5.dp, accent.copy(alpha = 0.75f), CircleShape)
                .clickable(enabled = !busy, onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector = if (active) Icons.Rounded.PowerSettingsNew else Icons.Rounded.Security,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(40.dp)
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = if (active) "قطع" else "اتصال",
                    color = RixColors.Text,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}