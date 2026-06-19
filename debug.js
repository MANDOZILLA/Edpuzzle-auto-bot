console.log('--- DEBUG START ---');
console.log('Body text preview:', document.body.innerText.substring(0, 500));
console.log('---');
console.log('Iframes:', document.querySelectorAll('iframe').length);
document.querySelectorAll('iframe').forEach(function(f, i) {
  console.log('  iframe ' + i + ':', f.src.substring(0, 80));
});
console.log('Checkboxes:', document.querySelectorAll('input[type=checkbox]').length);
console.log('Radio buttons:', document.querySelectorAll('input[type=radio]').length);
console.log('Buttons:', document.querySelectorAll('button').length);
document.querySelectorAll('button').forEach(function(b, i) {
  console.log('  btn ' + i + ':', b.innerText.substring(0, 30), b.disabled ? '(disabled)' : '');
});
console.log('--- DEBUG END ---');
