// 站点既有的交互脚本。挂件不应该动这个文件里的任何东西。
(function () {
  var links = document.querySelectorAll('.site-head nav a[href^="#"]');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // 首页三张卡片点击后的简单反馈，纯演示
  var cards = document.querySelectorAll('.grid article');
  for (var j = 0; j < cards.length; j++) {
    cards[j].addEventListener('click', function () {
      this.style.borderColor = '#6b7a5a';
    });
  }
})();
