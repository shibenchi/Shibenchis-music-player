package com.shibenchi.musicplayer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.TextPaint

// VizPainter's Gfx on an android canvas. begin() scales the canvas so the drawings work in the page's css pixels (see VizPainter), end()
// puts it back
class AndroidGfx : Gfx {
  private var canvas: Canvas? = null
  override var width = 0f
    private set
  override var height = 0f
    private set
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val path = Path()
  private val box = RectF()

  // the layers of blurLayer: the picture at 1/reduce of the size, then three more halvings (kept between pictures)
  private val layerBitmaps = arrayOfNulls<Bitmap>(4)
  private val layerCanvases = arrayOfNulls<Canvas>(4)
  private val layerGfx by lazy { AndroidGfx() }
  private val layerPaint = Paint(Paint.FILTER_BITMAP_FLAG)

  override fun blurLayer(reduce: Float, draw: (Gfx) -> Unit) {
    val c = canvas ?: return
    val w0 = maxOf(16, (width / reduce).toInt())
    val h0 = maxOf(16, (height / reduce).toInt())
    val sizes = (0 until 4).map { k -> intArrayOf(maxOf(4, w0 shr k), maxOf(4, h0 shr k)) }
    for (k in 0 until 4) {
      val have = layerBitmaps[k]
      if (have == null || have.width != sizes[k][0] || have.height != sizes[k][1]) {
        val made = Bitmap.createBitmap(sizes[k][0], sizes[k][1], Bitmap.Config.ARGB_8888)
        layerBitmaps[k] = made
        layerCanvases[k] = Canvas(made)
      }
      layerBitmaps[k]!!.eraseColor(0)
    }
    layerGfx.begin(layerCanvases[0]!!, w0 / width, w0.toFloat(), h0.toFloat())
    draw(layerGfx)
    layerGfx.end()
    for (k in 1 until 4) {
      layerCanvases[k]!!.drawBitmap(layerBitmaps[k - 1]!!, null, Rect(0, 0, sizes[k][0], sizes[k][1]), layerPaint)
    }
    c.drawBitmap(layerBitmaps[3]!!, null, RectF(0f, 0f, width, height), layerPaint)
  }

  fun begin(c: Canvas, scale: Float, widthPx: Float, heightPx: Float) {
    canvas = c
    c.save()
    c.scale(scale, scale)
    width = widthPx / scale
    height = heightPx / scale
  }

  fun end() {
    canvas?.restore()
    canvas = null
  }

  private fun fillPaint(color: Int): Paint {
    paint.style = Paint.Style.FILL
    paint.shader = null
    paint.color = color
    return paint
  }

  private fun strokePaint(lineWidth: Float, color: Int): Paint {
    paint.style = Paint.Style.STROKE
    paint.shader = null
    paint.strokeWidth = lineWidth
    paint.strokeJoin = Paint.Join.ROUND
    paint.strokeCap = Paint.Cap.BUTT
    paint.color = color
    return paint
  }

  override fun rect(x: Float, y: Float, w: Float, h: Float, color: Int) {
    canvas?.drawRect(x, y, x + w, y + h, fillPaint(color))
  }

  override fun circle(cx: Float, cy: Float, r: Float, color: Int) {
    canvas?.drawCircle(cx, cy, r, fillPaint(color))
  }

  override fun discGradient(cx: Float, cy: Float, r: Float, stops: FloatArray, colors: IntArray) {
    if (r <= 0f) return
    paint.style = Paint.Style.FILL
    paint.shader = RadialGradient(cx, cy, r, colors, stops, Shader.TileMode.CLAMP)
    canvas?.drawCircle(cx, cy, r, paint)
    paint.shader = null
  }

  override fun rectGradientV(x: Float, y: Float, w: Float, h: Float, y0: Float, y1: Float, stops: FloatArray, colors: IntArray) {
    paint.style = Paint.Style.FILL
    paint.shader = LinearGradient(0f, y0, 0f, y1, colors, stops, Shader.TileMode.CLAMP)
    canvas?.drawRect(x, y, x + w, y + h, paint)
    paint.shader = null
  }

  override fun rectGradientRadial(x: Float, y: Float, w: Float, h: Float, cx: Float, cy: Float, r: Float, stops: FloatArray, colors: IntArray) {
    if (r <= 0f) return
    paint.style = Paint.Style.FILL
    paint.shader = RadialGradient(cx, cy, r, colors, stops, Shader.TileMode.CLAMP)
    canvas?.drawRect(x, y, x + w, y + h, paint)
    paint.shader = null
  }

  override fun beginPath() = path.reset()

  override fun moveTo(x: Float, y: Float) = path.moveTo(x, y)

  override fun lineTo(x: Float, y: Float) = path.lineTo(x, y)

  override fun quadTo(cx: Float, cy: Float, x: Float, y: Float) = path.quadTo(cx, cy, x, y)

  override fun oval(cx: Float, cy: Float, rx: Float, ry: Float) {
    box.set(cx - rx, cy - ry, cx + rx, cy + ry)
    path.addOval(box, Path.Direction.CW)
  }

  override fun closePath() = path.close()

  override fun fill(color: Int) {
    canvas?.drawPath(path, fillPaint(color))
  }

  override fun stroke(lineWidth: Float, color: Int) {
    canvas?.drawPath(path, strokePaint(lineWidth, color))
  }

  override fun line(x1: Float, y1: Float, x2: Float, y2: Float, lineWidth: Float, color: Int) {
    canvas?.drawLine(x1, y1, x2, y2, strokePaint(lineWidth, color))
  }

  override fun save() {
    canvas?.save()
  }

  override fun restore() {
    canvas?.restore()
  }

  override fun clipRect(x: Float, y: Float, w: Float, h: Float) {
    canvas?.clipRect(x, y, x + w, y + h)
  }

  override fun rotate(radians: Float, px: Float, py: Float) {
    canvas?.rotate(Math.toDegrees(radians.toDouble()).toFloat(), px, py)
  }

  override fun text(s: String, x: Float, y: Float, size: Float, bold: Boolean, align: Int, color: Int) {
    textPaint.shader = null
    textPaint.style = Paint.Style.FILL
    textPaint.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    textPaint.textSize = size
    textPaint.textAlign = when (align) {
      1 -> Paint.Align.CENTER
      2 -> Paint.Align.RIGHT
      else -> Paint.Align.LEFT
    }
    textPaint.setShadowLayer(3f, 0f, 1f, 0xCC000000.toInt())
    textPaint.color = color
    canvas?.drawText(s, x, y, textPaint)
    textPaint.clearShadowLayer()
  }

  override fun textWidth(s: String, size: Float, bold: Boolean): Float {
    textPaint.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    textPaint.textSize = size
    return textPaint.measureText(s)
  }
}
