package com.colevana.tv;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.BridgeActivity;

/**
 * El WebChromeClient por defecto que trae Capacitor NO implementa
 * onShowCustomView/onHideCustomView. Eso significa que, aunque el sitio
 * (player-page.js) pida fullscreen con Element.requestFullscreen() sobre
 * #mediaSlot -o el propio <video> lo pida via webkitEnterFullscreen()-, el
 * WebView ignora el pedido en silencio: no hay error visible, pero la
 * pantalla nunca cambia. Esta clase agrega ese soporte para que el
 * fullscreen automatico funcione igual sea cual sea la fuente (video local
 * o iframe externo tipo godstream/hlswish), ya que ambos casos terminan
 * disparando el mismo mecanismo nativo de fullscreen del WebView.
 */
public class MainActivity extends BridgeActivity {

  private View customFullscreenView;
  private WebChromeClient.CustomViewCallback customViewCallback;
  private FrameLayout fullscreenContainer;
  private int savedSystemUiVisibility;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Habilita el inspector remoto (chrome://inspect en Chrome de
    // escritorio, con el dispositivo/emulador conectado por adb) para poder
    // ver la consola de JS del WebView y depurar cosas como el fullscreen.
    // Solo en builds debug: en release NO se debe dejar habilitado.
    if (BuildConfig.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true);
    }

    fullscreenContainer = findViewById(android.R.id.content);

    getBridge().getWebView().setWebChromeClient(new WebChromeClient() {
      @Override
      public void onShowCustomView(View view, CustomViewCallback callback) {
        if (customFullscreenView != null) {
          callback.onCustomViewHidden();
          return;
        }
        customFullscreenView = view;
        customViewCallback = callback;
        savedSystemUiVisibility = getWindow().getDecorView().getSystemUiVisibility();

        fullscreenContainer.addView(
            view,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        getBridge().getWebView().setVisibility(View.GONE);
        hideSystemUi();

        // Gira la pantalla a horizontal al entrar a fullscreen. En la web
        // (celular, navegador normal) esto lo resuelve la Screen
        // Orientation API de JS (initFullscreenOrientationLock en
        // player-page.js), pero esa misma API dentro del WebView del APK
        // no es confiable: muchos WebView de Android la ignoran o la
        // rechazan en silencio. Por eso lo hacemos aca a nivel nativo,
        // que es mucho mas confiable: onShowCustomView ya se dispara
        // exactamente cuando el video entra a fullscreen real (por el
        // boton de Plyr en celular, o por el teatro forzado en TV), asi
        // que es el mismo punto donde ya resolvemos ocultar la UI del
        // sistema. SENSOR_LANDSCAPE permite las dos orientaciones
        // horizontales (segun como el usuario sostenga el telefono) pero
        // nunca vuelve a vertical mientras dure el fullscreen.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
      }

      @Override
      public void onHideCustomView() {
        if (customFullscreenView == null) return;
        fullscreenContainer.removeView(customFullscreenView);
        customFullscreenView = null;
        getBridge().getWebView().setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(savedSystemUiVisibility);
        if (customViewCallback != null) {
          customViewCallback.onCustomViewHidden();
          customViewCallback = null;
        }

        // Al salir de fullscreen, soltamos el bloqueo de orientacion para
        // que el resto de la app (catalogo, etc.) vuelva a seguir al
        // sensor/rotacion normal del dispositivo, igual que en la web.
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
      }
    });

    // Evita que el WebView bloquee el fullscreen/autoplay del video por no
    // detectar un gesto de usuario "fresco" justo despues de navegar a
    // player.html (el tap en la portada de la pelicula ya fue el gesto).
    WebSettings webSettings = getBridge().getWebView().getSettings();
    webSettings.setMediaPlaybackRequiresUserGesture(false);

    // El JS necesita saber si esto es un televisor para poner el
    // reproductor propio en pantalla completa al abrir una pelicula.
    // El user agent del WebView en Android TV es el de un Android comun
    // (no dice "android tv"), asi que la deteccion por UA fallaba y el
    // televisor se quedaba con el video chico dentro de la pagina.
    //
    // Se expone de dos formas para que ninguna pagina quede afuera:
    //  1. window.ColevanaNative.isTv(): disponible desde el primer script.
    //  2. Marca en el user agent: sirve de respaldo y ademas la ve
    //     cualquier codigo que ya mire el UA (shared/device.js).
    getBridge().getWebView().addJavascriptInterface(new NativeDeviceBridge(), "ColevanaNative");
    if (isTvDevice()) {
      webSettings.setUserAgentString(webSettings.getUserAgentString() + " ColevanaTV/1");
    }

    // Esta es una app de TV: la UI del sistema (barra de estado/navegacion)
    // tiene que quedar oculta siempre, no solo cuando la Fullscreen API del
    // JS dispara onShowCustomView. Antes dependiamos de eso, pero
    // requestFullscreen() exige un gesto de usuario "fresco" que un control
    // remoto (sin touch) no siempre genera sobre el elemento correcto, asi
    // que el JS (ver tv-locked-fullscreen en player-page.js) ya no depende
    // de la Fullscreen API para el look fullscreen: solo de que el sistema
    // este oculto, que se resuelve aca.
    //
    // Este mismo APK tambien se instala en celulares (ver LEANBACK_LAUNCHER
    // + LAUNCHER en el manifest), y ahi NO queremos ocultar la UI del
    // sistema todo el tiempo: eso es solo para TV. En celular dejamos que
    // la UI del sistema se comporte normal, igual que en la web movil (que
    // ya funciona perfecto), y que se oculte solo cuando el video entra a
    // fullscreen real (eso sigue pasando siempre en onShowCustomView, sin
    // importar el dispositivo).
    if (isTvDevice()) {
      hideSystemUi();
    }
  }

  @Override
  public void onResume() {
    super.onResume();
    if (isTvDevice()) hideSystemUi();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus && isTvDevice()) hideSystemUi();
  }

  /**
   * Puente minimo hacia el JS: solo informa si el aparato es un televisor.
   * Lo consume shared/device.js (isTvDevice) y, a partir de ahi, el
   * reproductor decide el modo teatro / pantalla completa y el CSS agranda
   * los controles pensados para control remoto.
   */
  public class NativeDeviceBridge {
    @JavascriptInterface
    public boolean isTv() {
      return isTvDevice();
    }
  }

  // Deteccion oficial de Android para saber si estamos corriendo en un
  // televisor (Android TV / Google TV): UiModeManager es la forma nativa
  // recomendada, mas confiable que revisar el user agent del WebView. No
  // toca nada del comportamiento de TV en si, solo decide cuando aplicarlo.
  private boolean isTvDevice() {
    UiModeManager uiModeManager = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
    if (uiModeManager != null
        && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
      return true;
    }
    // Algunos TV box baratos reportan UI_MODE_TYPE_NORMAL pero igual
    // declaran el feature de TV (leanback) o no tienen pantalla tactil.
    PackageManager pm = getPackageManager();
    if (pm == null) return false;
    return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
  }

  // Capacitor 6 no maneja el boton "atras" del control remoto por si solo:
  // BridgeActivity no sobreescribe onBackPressed(), asi que sin esto cada
  // toque de "atras" ejecuta el comportamiento por defecto de Android
  // (Activity.onBackPressed() -> finish()) y cierra la app de una, sin
  // importar en que pagina este el WebView (catalogo, player, etc.).
  //
  // La navegacion entre paginas del sitio (index -> movies -> player, etc.)
  // se hace con <a href> normales, asi que el WebView SI va acumulando
  // historial propio. Lo unico que falta es pedirle que retroceda en ese
  // historial cuando lo haya; recien si no hay a donde volver (estamos en
  // la primera pagina) dejamos que Android cierre la app como es normal.
  @Override
  public void onBackPressed() {
    WebView webView = getBridge().getWebView();
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }
}