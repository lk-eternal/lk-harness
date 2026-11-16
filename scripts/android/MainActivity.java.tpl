package __PACKAGE__;

import android.os.Bundle;
import android.view.View;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

/**
 * lk-harness-ime-padding
 *
 * 这个文件由 CI 生成（scripts/patch-android-ime.cjs 把模板里的 __PACKAGE__ 换成真实包名），不在仓库的 android 目录里。
 *
 * 为什么要有它：安卓 15 起应用画到状态栏和导航栏后面（强制边到边），输入法弹出时系统不再把 WebView 缩小，
 * 键盘直接盖在页面上，底部的输入框就被挡住了。Capacitor 的壳对此什么都不做。
 *
 * 做法：用系统给的输入法高度（WindowInsets 的 ime 类型），给内容区底部让出「键盘实际盖住的那一段」，
 * 内容区里的 WebView 随之变矮，页面的 height: 100% 布局自己顶上来，和以前 adjustResize 的效果一样。
 *
 * 让出的高度按几何关系算（内容区底边落在键盘顶边下面多少），而不是直接用 ime 高度：
 * 系统或别的层已经把内容区缩到键盘上面时（旧版安卓的 adjustResize），盖住的部分是 0，这里就什么都不加，不会重复让出。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final View content = findViewById(android.R.id.content);
        if (content == null) {
            return;
        }
        // 输入法弹出、收起、换高度时系统会重新分发 insets；布局完成后再算一遍，纠正「分发时内容区还是旧尺寸」的那一次
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            syncImePadding(v);
            return insets;
        });
        content.getViewTreeObserver().addOnGlobalLayoutListener(() -> syncImePadding(content));
    }

    private static void syncImePadding(View content) {
        WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(content);
        int imeBottom = rootInsets == null ? 0 : rootInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        int overlap = 0;
        if (imeBottom > 0) {
            int[] location = new int[2];
            content.getLocationInWindow(location);
            overlap = imeOverlap(location[1], content.getHeight(), content.getRootView().getHeight(), imeBottom);
        }
        if (content.getPaddingBottom() != overlap) {
            content.setPadding(content.getPaddingLeft(), content.getPaddingTop(), content.getPaddingRight(), overlap);
        }
    }

    /**
     * 内容区底边被键盘盖住的高度。四个参数都在同一个坐标系（窗口坐标，向下为正）。
     * 内容区自身的位置和高度不受它的 padding 影响，所以设置 padding 后重新算不会来回抖。
     */
    static int imeOverlap(int contentTop, int contentHeight, int windowHeight, int imeBottom) {
        if (imeBottom <= 0 || contentHeight <= 0) {
            return 0;
        }
        int imeTop = windowHeight - imeBottom;
        int overlap = contentTop + contentHeight - imeTop;
        if (overlap < 0) {
            return 0;
        }
        return Math.min(overlap, contentHeight);
    }
}
