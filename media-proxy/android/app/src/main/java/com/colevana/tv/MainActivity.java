package com.colevana.tv;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
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
      }
    });

    // Evita que el WebView bloquee el fullscreen/autoplay del video por no
    // detectar un gesto de usuario "fresco" justo despues de navegar a
    // player.html (el tap en la portada de la pelicula ya fue el gesto).
    getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);

    // Esta es una app de TV: la UI del sistema (barra de estado/navegacion)
    // tiene que quedar oculta siempre, no solo cuando la Fullscreen API del
    // JS dispara onShowCustomView. Antes dependiamos de eso, pero
    // requestFullscreen() exige un gesto de usuario "fresco" que un control
    // remoto (sin touch) no siempre genera sobre el elemento correcto, asi
    // que el JS (ver tv-locked-fullscreen en player-page.js) ya no depende
    // de la Fullscreen API para el look fullscreen: solo de que el sistema
    // este oculto, que se resuelve aca.
    hideSystemUi();
  }

  @Override
  public void onResume() {
    super.onResume();
    hideSystemUi();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
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